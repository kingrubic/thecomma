import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const SESSION_RETENTION_MS = DAY_MS;
const CLOUDFLARE_CACHE_MS = 15 * 60 * 1000;
const TOP_PAGES_CACHE_MS = 5 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function formatDateTimeUtc(date) {
  return `${formatDateUtc(date)}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function vietnamDate(now = new Date()) {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000);
}

function vietnamDateKey(now = new Date(), offsetDays = 0) {
  return formatDateUtc(vietnamDate(new Date(now.getTime() + offsetDays * DAY_MS)));
}

function vietnamMonthKey(now = new Date()) {
  return vietnamDateKey(now).slice(0, 7);
}

function vietnamTodayRange(now = new Date()) {
  const local = vietnamDate(now);
  const startUtc = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    -7,
    0,
    0,
  ));
  return { startUtc, endUtc: now };
}

function isLikelyPage(requestPath) {
  if (!requestPath || !requestPath.startsWith("/")) return false;
  if (["/_next", "/api/", "/cdn-cgi/", "/uploads/"].some((prefix) => requestPath.startsWith(prefix))) return false;
  if (["/robots.txt", "/sitemap.xml", "/favicon.ico", "/admin", "/admin/", "/xmlrpc.php"].includes(requestPath)) return false;
  if (requestPath.split("/").some((segment) => segment.startsWith("."))) return false;
  if (/^\/(?:wp-admin|wp-content|wp-includes|wp-login\.php|xmlrpc\.php|phpmyadmin)(?:\/|$)/i.test(requestPath)) return false;
  if (/^\/(?:cmd|shell|env|cgi-bin|vendor|\.git)(?:[_./-]|$)/i.test(requestPath)) return false;
  return !/\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|map|json|txt|xml|pdf|php)$/i.test(requestPath);
}

function canonicalPagePath(requestPath) {
  if (requestPath === "/index.html" || requestPath.endsWith("/index.html")) {
    return requestPath.slice(0, -"index.html".length) || "/";
  }
  return requestPath;
}

function normalizeTopPages(pages, limit = 10) {
  const merged = new Map();
  for (const page of pages) {
    if (!isLikelyPage(page.path)) continue;
    const pagePath = canonicalPagePath(page.path);
    const current = merged.get(pagePath) ?? { path: pagePath, visits: 0, requests: 0 };
    current.visits += Number(page.visits) || 0;
    current.requests += Number(page.requests) || 0;
    merged.set(pagePath, current);
  }
  return [...merged.values()]
    .filter((page) => page.visits > 0)
    .sort((left, right) => right.visits - left.visits || right.requests - left.requests || left.path.localeCompare(right.path))
    .slice(0, limit);
}

export function createVisitorAnalytics({ rootDir, zoneId, token }) {
  const visitorStorePath = path.join(rootDir, "data", "visitor-stats.json");
  const monthlyStorePath = path.join(rootDir, "data", "cloudflare-top-pages-month.json");
  let writeQueue = Promise.resolve();
  let cloudflareCache = null;
  let topPagesSync = null;

  async function readVisitorStore() {
    try {
      const parsed = JSON.parse(await readFile(visitorStorePath, "utf8"));
      return {
        totalVisits: Number(parsed.totalVisits) || 0,
        dailyVisits: parsed.dailyVisits && typeof parsed.dailyVisits === "object" ? parsed.dailyVisits : {},
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      };
    } catch {
      return { totalVisits: 0, dailyVisits: {}, sessions: {} };
    }
  }

  async function writeVisitorStore(store) {
    await mkdir(path.dirname(visitorStorePath), { recursive: true });
    await writeFile(visitorStorePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  function pruneSessions(store, nowMs) {
    for (const [visitorId, session] of Object.entries(store.sessions)) {
      if (!session?.lastSeenAt || session.lastSeenAt < nowMs - SESSION_RETENTION_MS) delete store.sessions[visitorId];
    }
  }

  function localStats(store, nowMs) {
    const now = new Date(nowMs);
    const todayKey = vietnamDateKey(now);
    const yesterdayKey = vietnamDateKey(now, -1);
    return {
      totalVisits: store.totalVisits,
      todayVisits: store.dailyVisits[todayKey] ?? 0,
      yesterdayVisits: store.dailyVisits[yesterdayKey] ?? 0,
      onlineVisitors: Object.values(store.sessions).filter((session) => session.lastSeenAt >= nowMs - ONLINE_WINDOW_MS).length,
    };
  }

  async function updateVisitorStore(visitorId, event, nowMs = Date.now()) {
    const run = async () => {
      const store = await readVisitorStore();
      pruneSessions(store, nowMs);
      if (event === "pageview") {
        const todayKey = vietnamDateKey(new Date(nowMs));
        store.totalVisits += 1;
        store.dailyVisits[todayKey] = (store.dailyVisits[todayKey] ?? 0) + 1;
      }
      if (visitorId) {
        store.sessions[visitorId] = store.sessions[visitorId] ?? { createdAt: nowMs, lastSeenAt: nowMs };
        store.sessions[visitorId].lastSeenAt = nowMs;
      }
      await writeVisitorStore(store);
      return localStats(store, nowMs);
    };
    const result = writeQueue.then(run, run);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readLocalStats(nowMs = Date.now()) {
    const store = await readVisitorStore();
    pruneSessions(store, nowMs);
    return localStats(store, nowMs);
  }

  async function cloudflareRequest(query, variables) {
    if (!token) throw new Error("Cloudflare Analytics token is not configured.");
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Cloudflare API HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors[0]?.message ?? "Cloudflare GraphQL error");
    return payload.data?.viewer?.zones?.[0];
  }

  async function fetchCloudflarePageViews(now = new Date()) {
    if (cloudflareCache?.expiresAt > Date.now()) return cloudflareCache.stats;
    const periodStart = formatDateUtc(new Date(now.getTime() - 30 * DAY_MS));
    const periodEnd = formatDateUtc(now);
    const today = vietnamTodayRange(now);
    const dailyQuery = `query($zoneTag: string, $since: string, $until: string) { viewer { zones(filter: { zoneTag: $zoneTag }) { httpRequests1dGroups(limit: 31, filter: { date_geq: $since, date_leq: $until }) { sum { pageViews } } } } }`;
    const hourlyQuery = `query($zoneTag: string, $since: string, $until: string) { viewer { zones(filter: { zoneTag: $zoneTag }) { httpRequests1hGroups(limit: 48, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { pageViews } } } } }`;
    const [daily, hourly] = await Promise.all([
      cloudflareRequest(dailyQuery, { zoneTag: zoneId, since: periodStart, until: periodEnd }),
      cloudflareRequest(hourlyQuery, { zoneTag: zoneId, since: formatDateTimeUtc(today.startUtc), until: formatDateTimeUtc(today.endUtc) }),
    ]);
    const stats = {
      totalVisits: (daily?.httpRequests1dGroups ?? []).reduce((sum, row) => sum + (row.sum?.pageViews ?? 0), 0),
      todayVisits: (hourly?.httpRequests1hGroups ?? []).reduce((sum, row) => sum + (row.sum?.pageViews ?? 0), 0),
      yesterdayVisits: 0,
    };
    cloudflareCache = { stats, expiresAt: Date.now() + CLOUDFLARE_CACHE_MS };
    return stats;
  }

  async function fetchTopPages({ since, until, limit = 100 }) {
    const query = `query($zoneTag: string, $since: string, $until: string, $limit: int) { viewer { zones(filter: { zoneTag: $zoneTag }) { httpRequestsAdaptiveGroups(limit: $limit, orderBy: [sum_visits_DESC], filter: { datetime_geq: $since, datetime_leq: $until }) { count dimensions { clientRequestPath } sum { visits } } } } }`;
    const data = await cloudflareRequest(query, {
      zoneTag: zoneId,
      since: formatDateTimeUtc(since),
      until: formatDateTimeUtc(until),
      limit,
    });
    return normalizeTopPages((data?.httpRequestsAdaptiveGroups ?? []).map((row) => ({
      path: row.dimensions?.clientRequestPath ?? "/",
      visits: row.sum?.visits ?? 0,
      requests: row.count ?? 0,
    })));
  }

  async function readMonthlyStore(monthKey = vietnamMonthKey()) {
    try {
      const parsed = JSON.parse(await readFile(monthlyStorePath, "utf8"));
      if (parsed.monthKey === monthKey && parsed.dailyPages && typeof parsed.dailyPages === "object") return parsed;
    } catch {
      // A fresh store is valid on first run.
    }
    return { monthKey, updatedAt: new Date(0).toISOString(), pages: {}, dailyPages: {} };
  }

  async function syncTopPages(now = new Date(), force = false) {
    if (!force && topPagesSync?.expiresAt > Date.now()) return topPagesSync.value;
    const todayRange = vietnamTodayRange(now);
    const todayPages = await fetchTopPages({ since: todayRange.startUtc, until: todayRange.endUtc });
    const store = await readMonthlyStore(vietnamMonthKey(now));
    store.dailyPages[vietnamDateKey(now)] = Object.fromEntries(todayPages.map((page) => [page.path, { visits: page.visits, requests: page.requests }]));
    const merged = {};
    for (const dayPages of Object.values(store.dailyPages)) {
      for (const [pagePath, stats] of Object.entries(dayPages)) {
        merged[pagePath] = merged[pagePath] ?? { visits: 0, requests: 0 };
        merged[pagePath].visits += stats.visits;
        merged[pagePath].requests += stats.requests;
      }
    }
    store.pages = merged;
    store.updatedAt = now.toISOString();
    await mkdir(path.dirname(monthlyStorePath), { recursive: true });
    await writeFile(monthlyStorePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    const value = { store, todayPages };
    topPagesSync = { value, expiresAt: Date.now() + TOP_PAGES_CACHE_MS };
    return value;
  }

  async function getPublicStats({ visitorId, event = "read" }) {
    const local = event === "read" ? await readLocalStats() : await updateVisitorStore(visitorId, event);
    try {
      return { ...local, ...(await fetchCloudflarePageViews()) };
    } catch {
      return local;
    }
  }

  async function getAdminStats() {
    const [stats, topPages] = await Promise.all([
      getPublicStats({ event: "read" }),
      syncTopPages().catch(async () => ({ store: await readMonthlyStore(), todayPages: [] })),
    ]);
    return {
      stats,
      topPagesToday: topPages.todayPages,
      topPagesMonth: normalizeTopPages(Object.entries(topPages.store.pages ?? {}).map(([pagePath, values]) => ({ path: pagePath, ...values }))),
      monthKey: topPages.store.monthKey,
      monthlyUpdatedAt: topPages.store.updatedAt,
      timezone: "Asia/Ho_Chi_Minh",
    };
  }

  return { getAdminStats, getPublicStats, syncTopPages };
}
