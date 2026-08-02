import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
import { renderMarkdown, escapeHtml } from "./markdown.mjs";
import { analyzeSeo } from "./seo-analysis.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_COOKIE = "thecomma_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const UPLOAD_DIR = path.join(ROOT, "public", "uploads", "blog");
const MAX_JSON_BYTES = 1_200_000;
const MAX_UPLOAD_BYTES = 6_000_000;
const AGENT_TOKEN_SERVICE = "thecomma-agent-publishing-token";

function readEnvFile() {
  const values = {};
  try {
    const source = requireText(path.join(ROOT, ".env.local"));
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // The server also has a safe local fallback for first boot.
  }
  return values;
}

function requireText(filePath) {
  // This helper is intentionally synchronous only during startup. Keeping the
  // parser dependency-free means the static THE COMMA site remains easy to move.
  const fs = process.getBuiltinModule?.("node:fs");
  if (!fs) throw new Error("Builtin fs unavailable");
  return fs.readFileSync(filePath, "utf8");
}

const envFile = readEnvFile();
const CONVEX_URL = (
  process.env.THECOMMA_CONVEX_URL ||
  process.env.CONVEX_URL ||
  envFile.THECOMMA_CONVEX_URL ||
  envFile.CONVEX_URL ||
  "http://127.0.0.1:3240"
).replace(/\/$/, "");
const convex = new ConvexHttpClient(CONVEX_URL);

await mkdir(UPLOAD_DIR, { recursive: true });

const loginFailures = new Map();
const agentRequests = new Map();

function readKeychainToken(service) {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-a", "vsc_agent", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const AGENT_PUBLISHING_TOKEN = process.env.AGENT_PUBLISHING_TOKEN || envFile.AGENT_PUBLISHING_TOKEN || readKeychainToken(AGENT_TOKEN_SERVICE);

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function errorMessage(error, fallback = "Request failed.") {
  const message = String(error?.data?.message || error?.message || "");
  if (!message || message.includes("at ") || message.length > 240) return fallback;
  return message;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]),
  );
}

function cookieHeader(token, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearCookieHeader(secure) {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(forwarded || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = req.headers.host;
    return originUrl.host === host;
  } catch {
    return false;
  }
}

function readBearerToken(req) {
  const header = String(req.headers.authorization || "");
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
}

function constantTimeTokenMatch(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function agentRateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = agentRequests.get(ip);
  if (!entry || entry.resetAt <= now) {
    agentRequests.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 30;
}

function requireAgent(req, res) {
  if (!AGENT_PUBLISHING_TOKEN) {
    json(res, 503, { error: "Agent publishing is not configured." });
    return false;
  }
  if (!constantTimeTokenMatch(readBearerToken(req), AGENT_PUBLISHING_TOKEN)) {
    json(res, 401, { error: "Unauthorized agent request." });
    return false;
  }
  if (agentRateLimited(req)) {
    json(res, 429, { error: "Agent rate limit exceeded." }, { "Retry-After": "60" });
    return false;
  }
  return true;
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
}

function makeExcerpt(content) {
  const plainText = String(content || "").replace(/[#>*_`~-]/g, " ").replace(/\s+/g, " ").trim();
  return plainText.length > 180 ? `${plainText.slice(0, 177)}...` : plainText;
}

/** Draft upsert payload — status is always forced to draft. */
function normalizeAgentDraftInput(body, { slugFallback = "" } = {}) {
  const content = String(body.content || "").trim();
  const normalized = normalizePostInput({
    ...body,
    slug: String(body.slug || slugFallback || "").trim() || slugify(body.title),
    excerpt: String(body.excerpt || "").trim() || makeExcerpt(content),
    status: "draft",
  });
  const { status: _status, scheduledAt: _scheduledAt, publishedAt: _publishedAt, ...draft } = normalized;
  return draft;
}

function normalizeAgentPublishInput(body) {
  const publishStatus = String(body.status || "published");
  if (!["published", "scheduled"].includes(publishStatus)) {
    throw new Error("status phải là published hoặc scheduled.");
  }
  let scheduledAt;
  if (publishStatus === "scheduled") {
    scheduledAt =
      typeof body.scheduledAt === "string" ? Date.parse(body.scheduledAt) : Number(body.scheduledAt);
    if (!Number.isFinite(scheduledAt) || scheduledAt < Date.now() - 60_000) {
      throw new Error("Bài hẹn giờ cần một thời điểm hợp lệ trong tương lai.");
    }
  }
  return { status: publishStatus, scheduledAt };
}

async function republishStoriesForAgent() {
  const posts = await queryConvex(api.posts.listAllForAgent, {
    agentToken: AGENT_PUBLISHING_TOKEN,
  });
  return await publishStoriesSite(posts);
}

function agentPostSummary(post) {
  if (!post) return null;
  return {
    id: post._id || post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    category: post.category,
    tags: post.tags,
    author: post.author,
    status: post.status,
    coverImage: post.coverImage || null,
    focusKeyword: post.focusKeyword || null,
    publishedAt: post.publishedAt || null,
    scheduledAt: post.scheduledAt || null,
    updatedAt: post.updatedAt || null,
    url: `https://thecommacoffee.com/stories/${post.slug}/`,
  };
}

function formatAgentSeo(post) {
  const analysis = analyzeSeo(post, "thecomma");
  return {
    score: analysis.score,
    signal: analysis.signal,
    label: analysis.label,
    stats: analysis.stats,
    counts: { errors: analysis.errorCount, warnings: analysis.warningCount, good: analysis.goodCount },
    topIssues: analysis.issues.filter((issue) => issue.severity !== "good").slice(0, 8),
    allIssues: analysis.issues,
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, MAX_JSON_BYTES);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { statusCode: 400 });
  }
}

function normalizeTags(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  return [...new Set(values.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function normalizeCategoryName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) {
    throw new Error("Tên chuyên mục cần từ 2 đến 60 ký tự.");
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Tên chuyên mục chứa ký tự không hợp lệ.");
  }
  return name;
}

function categoryErrorStatus(error) {
  const message = errorMessage(error, "");
  const rawMessage = [error?.data?.message, error?.message, error?.data]
    .map((value) => String(value || ""))
    .join(" ");
  if (message.includes("Không tìm thấy") || rawMessage.includes("Không tìm thấy")) return 404;
  if (
    message.includes("đã tồn tại") ||
    message.includes("đang được dùng") ||
    rawMessage.includes("đã tồn tại") ||
    rawMessage.includes("đang được dùng")
  ) return 409;
  return Number(error?.statusCode) || 400;
}

function categoryErrorMessage(error, fallback) {
  const rawMessage = [error?.data?.message, error?.message, error?.data]
    .map((value) => String(value || ""))
    .join(" ");
  if (rawMessage.includes("đã tồn tại")) return "Chuyên mục này đã tồn tại.";
  if (rawMessage.includes("đang được dùng")) {
    return "Không thể xóa chuyên mục đang được dùng bởi bài viết. Hãy đổi chuyên mục cho các bài trước.";
  }
  if (rawMessage.includes("Không tìm thấy")) return "Không tìm thấy chuyên mục.";
  return errorMessage(error, fallback);
}

function normalizePostInput(body) {
  const title = String(body.title || "").trim();
  const slug = String(body.slug || "").trim().toLowerCase();
  const excerpt = String(body.excerpt || "").trim();
  const content = String(body.content || "").trim();
  const focusKeyword = String(body.focusKeyword || "").trim().slice(0, 120);
  const category = String(body.category || "Câu chuyện đồ uống").trim();
  const author = String(body.author || "THE COMMA").trim();
  const postStatus = String(body.status || "draft");
  const coverImage = String(body.coverImage || "").trim();

  if (title.length < 3 || title.length > 160) throw new Error("Tiêu đề cần từ 3 đến 160 ký tự.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160) {
    throw new Error("Slug chỉ dùng chữ thường, số và dấu gạch ngang.");
  }
  if (excerpt.length < 10 || excerpt.length > 500) throw new Error("Mô tả ngắn cần từ 10 đến 500 ký tự.");
  if (content.length < 20 || content.length > 100000) throw new Error("Nội dung cần từ 20 đến 100.000 ký tự.");
  if (category.length < 2 || category.length > 60) throw new Error("Chuyên mục không hợp lệ.");
  if (author.length < 2 || author.length > 80) throw new Error("Tên tác giả không hợp lệ.");
  if (!["draft", "published", "scheduled"].includes(postStatus)) throw new Error("Trạng thái không hợp lệ.");

  let scheduledAt;
  if (postStatus === "scheduled") {
    scheduledAt = Number(body.scheduledAt);
    if (!Number.isFinite(scheduledAt) || scheduledAt < Date.now() - 60_000) {
      throw new Error("Bài hẹn giờ cần một thời điểm hợp lệ trong tương lai.");
    }
  }

  const result = {
    title,
    slug,
    excerpt,
    content,
    focusKeyword: focusKeyword || undefined,
    category,
    tags: normalizeTags(body.tags),
    status: postStatus,
    author,
  };
  if (coverImage) {
    if (!/^\/(uploads|images)\//.test(coverImage) && !/^https:\/\//i.test(coverImage)) {
      throw new Error("Ảnh cover phải là đường dẫn nội bộ hoặc HTTPS.");
    }
    result.coverImage = coverImage;
  }
  if (scheduledAt) result.scheduledAt = scheduledAt;
  return result;
}

async function getAdmin(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const user = await convex.query(api.adminAuth.me, { token });
    return user ? { token, user } : null;
  } catch {
    return null;
  }
}

async function requireAdmin(req, res, { allowPasswordChange = false } = {}) {
  const admin = await getAdmin(req);
  if (!admin) {
    json(res, 401, { error: "Vui lòng đăng nhập để tiếp tục." });
    return null;
  }
  if (admin.user.mustChangePassword && !allowPasswordChange) {
    json(res, 403, {
      error: "Bạn cần đổi mật khẩu tạm thời trước khi sử dụng Content Studio.",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    return null;
  }
  return admin;
}

async function queryConvex(operation, args) {
  return await convex.query(operation, args);
}

async function mutationConvex(operation, args) {
  return await convex.mutation(operation, args);
}

function publicPost(post) {
  return {
    id: post._id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    coverImage: post.coverImage || null,
    category: post.category,
    tags: post.tags,
    author: post.author,
    publishedAt: post.publishedAt || post.scheduledAt || null,
    readMinutes: post.readMinutes || Math.max(1, Math.ceil(post.content.trim().split(/\s+/).filter(Boolean).length / 220)),
  };
}

function publicFullPost(post) {
  return {
    ...publicPost(post),
    contentHtml: renderMarkdown(post.content),
  };
}

function storyCategoryLabel(value) {
  const key = String(value || "").trim().toLowerCase();
  const labels = {
    coffee: "Cà phê",
    tea: "Trà",
    matcha: "Matcha",
    season: "Món theo mùa",
  };
  return labels[key] || String(value || "THE COMMA").trim() || "THE COMMA";
}

function storyDrinkName(title) {
  const raw = String(title || "").split(":")[0].trim();
  return raw.replace(/^[“"']+|[”"']+$/g, "").trim() || "THE COMMA";
}

function storyMetaDescription(post) {
  return String(post.excerpt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function storyImage(post) {
  if (post.coverImage) return post.coverImage.startsWith("/") || /^https?:\/\//i.test(post.coverImage)
    ? post.coverImage
    : `/${post.coverImage.replace(/^\/+/, "")}`;
  const fallbacks = {
    coffee: "/images/stories/category-coffee.jpg",
    tea: "/images/stories/category-tea.jpg",
    matcha: "/images/stories/category-matcha.jpg",
    season: "/images/stories/tra-quyt-theo-mua.jpg",
  };
  return fallbacks[String(post.category || "").trim().toLowerCase()] || "/images/stories/category-coffee.jpg";
}

function publicStories(posts) {
  return [...posts]
    .filter((post) => post.status === "published" || (post.status === "scheduled" && (post.scheduledAt ?? Infinity) <= Date.now()))
    .sort((a, b) => (b.publishedAt ?? b.scheduledAt ?? b.updatedAt ?? 0) - (a.publishedAt ?? a.scheduledAt ?? a.updatedAt ?? 0));
}

function storyManifest(posts) {
  return posts.map((post) => ({
    slug: post.slug,
    title: post.title,
    meta_title: `${post.title} | The Comma Coffee`,
    meta_description: storyMetaDescription(post),
    focus_keyword: storyDrinkName(post.title),
    category: String(post.category || "").trim().toLowerCase(),
    drink_name: storyDrinkName(post.title),
    image_brief: `Ảnh cho ${storyDrinkName(post.title)} tại The Comma, ${storyCategoryLabel(post.category)}.`,
    image: storyImage(post).replace(/^https?:\/\/[^/]+/i, ""),
  }));
}

function storyCardHtml(post, index) {
  const number = String(index + 1).padStart(2, "0");
  const categoryLabel = storyCategoryLabel(post.category);
  const drinkName = storyDrinkName(post.title);
  const image = escapeHtml(storyImage(post));
  return `
    <article class="story-card">
      <a class="story-card-media" href="${escapeHtml(`/stories/${post.slug}/`)}"><img src="${image}" alt="${escapeHtml(drinkName)} — The Comma" loading="lazy"><span class="story-card-no">${number}</span></a>
      <div class="story-card-meta"><span>${escapeHtml(categoryLabel)}</span><span>${escapeHtml(drinkName)}</span></div>
      <h2><a href="${escapeHtml(`/stories/${post.slug}/`)}">${escapeHtml(post.title)}</a></h2>
      <p>${escapeHtml(storyMetaDescription(post))}</p>
    </article>`;
}

function storyIndexHtml(posts) {
  const cards = posts.map((post, index) => storyCardHtml(post, index)).join("");
  const itemList = posts.map((post, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: post.title,
  }));
  const ldJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Tạp chí nguyên liệu — The Comma Coffee",
    description: "Những câu chuyện mới nhất tại The Comma Coffee.",
    mainEntity: { "@type": "ItemList", numberOfItems: posts.length, itemListElement: itemList },
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="vi"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="theme-color" content="#85866f">
  <title>Tạp chí nguyên liệu | The Comma Coffee</title>
  <meta name="description" content="Những câu chuyện mới nhất tại The Comma Coffee, được biên tập từ studio nội dung của quán.">
  <meta property="og:type" content="article">
  <meta property="og:title" content="Tạp chí nguyên liệu | The Comma Coffee">
  <meta property="og:description" content="Những câu chuyện mới nhất tại The Comma Coffee, được biên tập từ studio nội dung của quán.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Arsenal:ital,wght@0,400;0,700;1,400;1,700&family=Noto+Serif+Display:ital,opsz,wght@0,6..144,300;0,6..144,400;0,6..144,600;1,6..144,300;1,6..144,400&display=swap&subset=vietnamese" rel="stylesheet">
  <link rel="stylesheet" href="/css/comma.css">
  <link rel="stylesheet" href="/css/stories.css">
  <script type="application/ld+json">${ldJson}</script>
</head><body class="story-page">
<header class="journal-nav">
  <a class="journal-logo" href="/" aria-label="The Comma — Trang chủ"><img src="/images/the-comma-logo.png" alt="The Comma"></a>
  <span class="journal-nav-label">Tạp chí nguyên liệu</span>
  <a class="journal-nav-home" href="/#menu"><span>Xem menu</span><i>↗</i></a>
</header>
<main>
<section class="journal-hero"><div class="journal-hero-inner"><p class="journal-kicker">THE COMMA / INGREDIENT JOURNAL</p><h1>Mỗi món có một câu chuyện.<br><em>Mỗi mùa có một cách kể.</em></h1><p>Những bài mới nhất được xuất bản từ studio nội dung The Comma, gọn, rõ và bám đúng nguyên liệu đã xác nhận.</p><div class="journal-filter-note">${posts.length} bài · Cà phê · Trà · Matcha · Season</div></div></section>
<section class="journal-index"><div class="journal-index-grid">${cards || '<div class="empty-state">Chưa có bài nào được xuất bản.</div>'}</div></section>
</main></body></html>`;
}

function storyArticleHtml(post, posts) {
  const related = posts.filter((item) => item.slug !== post.slug).slice(0, 3);
  const ingredients = (post.tags || []).length
    ? `<div class="article-ingredients">${post.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  const relatedHtml = related.length
    ? `<section class="related-stories"><div class="related-inner"><p class="journal-kicker">ĐỌC TIẾP</p><h2>Những câu chuyện cùng bàn</h2><div class="related-grid">${related.map((item) => `<a class="related-item" href="/stories/${escapeHtml(item.slug)}/"><small>${escapeHtml(storyCategoryLabel(item.category))}</small><h3>${escapeHtml(item.title)}</h3></a>`).join("")}</div></div></section>`
    : "";
  return `<!doctype html><html lang="vi"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="theme-color" content="#85866f">
  <title>${escapeHtml(post.title)} | The Comma Coffee</title>
  <meta name="description" content="${escapeHtml(storyMetaDescription(post))}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(post.title)}">
  <meta property="og:description" content="${escapeHtml(storyMetaDescription(post))}">
  <meta property="og:image" content="${escapeHtml(storyImage(post))}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Arsenal:ital,wght@0,400;0,700;1,400;1,700&family=Noto+Serif+Display:ital,opsz,wght@0,6..144,300;0,6..144,400;0,6..144,600;1,6..144,300;1,6..144,400&display=swap&subset=vietnamese" rel="stylesheet">
  <link rel="stylesheet" href="/css/comma.css">
  <link rel="stylesheet" href="/css/stories.css">
</head><body class="story-page">
<header class="journal-nav">
  <a class="journal-logo" href="/" aria-label="The Comma — Trang chủ"><img src="/images/the-comma-logo.png" alt="The Comma"></a>
  <span class="journal-nav-label">${escapeHtml(storyCategoryLabel(post.category))}</span>
  <a class="journal-nav-home" href="/stories/"><span>Về tạp chí</span><i>↗</i></a>
</header>
<main>
<header class="article-hero"><div class="article-hero-copy"><p class="journal-kicker">${escapeHtml(storyCategoryLabel(post.category))} / THE COMMA</p><h1>${escapeHtml(post.title)}</h1><p class="article-excerpt">${escapeHtml(storyMetaDescription(post))}</p>${ingredients}</div><figure class="article-hero-media"><img src="${escapeHtml(storyImage(post))}" alt="${escapeHtml(post.title)} — The Comma"></figure></header>
<section class="article-layout"><article class="article-body">${renderMarkdown(post.content)}</article></section>
${relatedHtml}
</main></body></html>`;
}

async function publishStoriesSite(posts) {
  const publicPosts = publicStories(posts);
  const storiesDir = path.join(ROOT, "stories");
  await mkdir(storiesDir, { recursive: true });
  await writeFile(path.join(storiesDir, "story-manifest.json"), `${JSON.stringify(storyManifest(publicPosts), null, 2)}\n`);
  await writeFile(path.join(storiesDir, "index.html"), storyIndexHtml(publicPosts));
  for (const post of publicPosts) {
    const pageDir = path.join(storiesDir, post.slug);
    await mkdir(pageDir, { recursive: true });
    await writeFile(path.join(pageDir, "index.html"), storyArticleHtml(post, publicPosts));
  }
  const keep = new Set(publicPosts.map((post) => post.slug));
  for (const entry of await readdir(storiesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    await rm(path.join(storiesDir, entry.name), { recursive: true, force: true });
  }
  return { published: publicPosts.length };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveFile(res, filePath, cache = false) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": cache ? "public, max-age=300" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function safeStaticPath(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  if (decoded.includes("\0") || decoded.includes("..")) return null;
  return path.join(ROOT, decoded.replace(/^\/+/, ""));
}

function slugFromPath(requestPath) {
  const match = /^\/stories\/([^/]+)\/?$/.exec(requestPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const current = loginFailures.get(ip) || { count: 0, resetAt: now + 15 * 60_000 };
  if (current.resetAt < now) {
    current.count = 0;
    current.resetAt = now + 15 * 60_000;
  }
  current.count += 1;
  loginFailures.set(ip, current);
}

function loginBlocked(ip) {
  const current = loginFailures.get(ip);
  if (!current || current.resetAt < Date.now()) return false;
  return current.count >= 8;
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return text(res, 204, "");
  if (!sameOrigin(req)) return json(res, 403, { error: "Origin not allowed." });

  if (req.method === "GET" && url.pathname === "/api/public/posts") {
    try {
      const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);
      const category = url.searchParams.get("category") || undefined;
      const posts = await queryConvex(api.posts.listPublished, { limit, category });
      return json(res, 200, { posts: posts.map(publicPost) });
    } catch (error) {
      return json(res, 503, { error: "Nội dung tạm thời chưa sẵn sàng." });
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/public/posts/")) {
    const slug = decodeURIComponent(url.pathname.slice("/api/public/posts/".length));
    if (!slug || slug.includes("/")) return json(res, 400, { error: "Slug không hợp lệ." });
    try {
      const post = await queryConvex(api.posts.getBySlug, { slug });
      return post ? json(res, 200, { post: publicFullPost(post) }) : json(res, 404, { error: "Không tìm thấy bài viết." });
    } catch {
      return json(res, 503, { error: "Nội dung tạm thời chưa sẵn sàng." });
    }
  }

  if (url.pathname === "/api/agent/categories" && req.method === "GET") {
    if (!requireAgent(req, res)) return;
    try {
      const categories = await queryConvex(api.categories.listForAgent, {});
      return json(res, 200, { categories });
    } catch {
      return json(res, 503, { error: "Không tải được chuyên mục." });
    }
  }

  if (url.pathname === "/api/agent/seo" && req.method === "POST") {
    if (!requireAgent(req, res)) return;
    try {
      const body = await readJson(req);
      if (!String(body.title || "").trim() || !String(body.content || "").trim()) {
        return json(res, 400, { error: "SEO check cần title và content." });
      }
      return json(res, 200, { ok: true, site: "thecomma", seo: formatAgentSeo(body) });
    } catch (error) {
      return json(res, error.statusCode || 400, { error: errorMessage(error, "SEO check thất bại.") });
    }
  }

  if (url.pathname === "/api/agent/posts" && req.method === "GET") {
    if (!requireAgent(req, res)) return;
    try {
      const posts = await queryConvex(api.posts.listAllForAgent, { agentToken: AGENT_PUBLISHING_TOKEN });
      const statusFilter = url.searchParams.get("status");
      const filtered = statusFilter
        ? posts.filter((post) => post.status === statusFilter)
        : posts;
      return json(res, 200, { posts: filtered.map(agentPostSummary) });
    } catch (error) {
      return json(res, 500, { error: errorMessage(error, "Không tải được danh sách bài.") });
    }
  }

  if (url.pathname === "/api/agent/posts" && req.method === "POST") {
    if (!requireAgent(req, res)) return;
    try {
      const body = await readJson(req);
      if (body.status && body.status !== "draft") {
        return json(res, 400, {
          error:
            "Agent chỉ được tạo bài ở trạng thái draft. Dùng POST /api/agent/posts/:slug/publish sau khi chủ nhân duyệt.",
        });
      }
      const draft = normalizeAgentDraftInput(body);
      if (body.dryRun === true) {
        return json(res, 200, {
          ok: true,
          dryRun: true,
          post: { ...draft, status: "draft" },
          seo: formatAgentSeo({ ...draft, status: "draft" }),
        });
      }
      const result = await mutationConvex(api.posts.upsertDraftFromAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        ...draft,
      });
      return json(res, result.action === "created" ? 201 : 200, {
        ok: true,
        ...result,
        url: `https://thecommacoffee.com/stories/${draft.slug}/`,
      });
    } catch (error) {
      const message = errorMessage(error, "Không tạo/cập nhật được draft.");
      const conflict =
        message.includes("published/scheduled") || message.includes("unpublish");
      return json(res, error.statusCode || (conflict ? 409 : 400), { error: message });
    }
  }

  const agentPublishMatch = /^\/api\/agent\/posts\/([^/]+)\/publish$/.exec(url.pathname);
  if (agentPublishMatch && req.method === "POST") {
    if (!requireAgent(req, res)) return;
    try {
      const slug = decodeURIComponent(agentPublishMatch[1]);
      const publish = normalizeAgentPublishInput(await readJson(req));
      const result = await mutationConvex(api.posts.publishFromAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        slug,
        ...publish,
      });
      const site = await republishStoriesForAgent();
      return json(res, 200, {
        ok: true,
        ...result,
        site,
        url: `https://thecommacoffee.com/stories/${slug}/`,
      });
    } catch (error) {
      return json(res, error.statusCode || 400, {
        error: errorMessage(error, "Không publish được bài."),
      });
    }
  }

  const agentUnpublishMatch = /^\/api\/agent\/posts\/([^/]+)\/unpublish$/.exec(url.pathname);
  if (agentUnpublishMatch && req.method === "POST") {
    if (!requireAgent(req, res)) return;
    try {
      const slug = decodeURIComponent(agentUnpublishMatch[1]);
      const result = await mutationConvex(api.posts.unpublishFromAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        slug,
      });
      const site = await republishStoriesForAgent();
      return json(res, 200, { ok: true, ...result, site });
    } catch (error) {
      return json(res, error.statusCode || 400, {
        error: errorMessage(error, "Không unpublish được bài."),
      });
    }
  }

  const agentPostMatch = /^\/api\/agent\/posts\/([^/]+)$/.exec(url.pathname);
  if (agentPostMatch && req.method === "GET") {
    if (!requireAgent(req, res)) return;
    try {
      const slug = decodeURIComponent(agentPostMatch[1]);
      const post = await queryConvex(api.posts.getForAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        slug,
      });
      if (!post) return json(res, 404, { error: "Không tìm thấy bài viết." });
      return json(res, 200, { post: { ...agentPostSummary(post), content: post.content } });
    } catch (error) {
      return json(res, 500, { error: errorMessage(error, "Không tải được bài.") });
    }
  }

  if (agentPostMatch && req.method === "PATCH") {
    if (!requireAgent(req, res)) return;
    try {
      const slug = decodeURIComponent(agentPostMatch[1]);
      const body = await readJson(req);
      if (body.status && body.status !== "draft") {
        return json(res, 400, {
          error: "Không đổi status qua PATCH. Dùng /publish hoặc /unpublish.",
        });
      }
      const existing = await queryConvex(api.posts.getForAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        slug,
      });
      if (!existing) return json(res, 404, { error: "Không tìm thấy bài viết." });
      if (existing.status !== "draft") {
        return json(res, 409, {
          error: "Bài đang published/scheduled. Hãy unpublish về draft trước khi sửa.",
        });
      }
      const draft = normalizeAgentDraftInput(
        {
          title: body.title ?? existing.title,
          slug: body.slug ?? existing.slug,
          excerpt: body.excerpt ?? existing.excerpt,
          content: body.content ?? existing.content,
          focusKeyword: body.focusKeyword ?? existing.focusKeyword,
          coverImage: body.coverImage ?? existing.coverImage,
          category: body.category ?? existing.category,
          tags: body.tags ?? existing.tags,
          author: body.author ?? existing.author,
        },
        { slugFallback: slug },
      );
      if (draft.slug !== slug) {
        const clash = await queryConvex(api.posts.getForAgent, {
          agentToken: AGENT_PUBLISHING_TOKEN,
          slug: draft.slug,
        });
        if (clash) {
          return json(res, 409, { error: "Slug mới đã tồn tại." });
        }
      }
      // Upsert by target slug; if renaming, write new slug then delete old draft row.
      const result = await mutationConvex(api.posts.upsertDraftFromAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        ...draft,
      });
      if (draft.slug !== slug) {
        await mutationConvex(api.posts.removeDraftFromAgent, {
          agentToken: AGENT_PUBLISHING_TOKEN,
          slug,
        });
      }
      return json(res, 200, {
        ok: true,
        ...result,
        url: `https://thecommacoffee.com/stories/${draft.slug}/`,
      });
    } catch (error) {
      return json(res, error.statusCode || 400, {
        error: errorMessage(error, "Không cập nhật được draft."),
      });
    }
  }

  if (agentPostMatch && req.method === "DELETE") {
    if (!requireAgent(req, res)) return;
    try {
      const result = await mutationConvex(api.posts.removeDraftFromAgent, {
        agentToken: AGENT_PUBLISHING_TOKEN,
        slug: decodeURIComponent(agentPostMatch[1]),
      });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, error.statusCode || 403, {
        error: errorMessage(error, "Không thể xóa draft."),
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return json(res, 429, { error: "Quá nhiều lần thử. Vui lòng chờ ít phút." });
    try {
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!username || !password) throw new Error("Nhập tên đăng nhập và mật khẩu.");
      const result = await mutationConvex(api.adminAuth.login, { username, password });
      clearLoginFailures(ip);
      return json(res, 200, { user: result.user }, { "Set-Cookie": cookieHeader(result.token, isSecureRequest(req)) });
    } catch (error) {
      recordLoginFailure(ip);
      return json(res, error.statusCode || 401, { error: error.statusCode ? errorMessage(error) : "Tên đăng nhập hoặc mật khẩu không đúng." });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      try { await mutationConvex(api.adminAuth.logout, { token }); } catch { /* cookie is still cleared */ }
    }
    return json(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeader(isSecureRequest(req)) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/me") {
    const admin = await getAdmin(req);
    return admin ? json(res, 200, { user: admin.user }) : json(res, 401, { user: null });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/setup-status") {
    try {
      const status = await queryConvex(api.adminAuth.setupStatus, {});
      return json(res, 200, status);
    } catch {
      return json(res, 503, { error: "Convex local backend chưa sẵn sàng." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/admin/posts") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const posts = await queryConvex(api.posts.listAll, { token: admin.token });
      return json(res, 200, { posts });
    } catch (error) {
      return json(res, 500, { error: errorMessage(error, "Không tải được danh sách bài viết.") });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/admin/categories") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const categories = await queryConvex(api.categories.list, { token: admin.token });
      return json(res, 200, { categories });
    } catch (error) {
      return json(res, 500, { error: errorMessage(error, "Không tải được danh sách chuyên mục.") });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/categories") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = await readJson(req);
      const name = normalizeCategoryName(body.name);
      const category = await mutationConvex(api.categories.create, { token: admin.token, name });
      await publishStoriesSite(await queryConvex(api.posts.listAll, { token: admin.token }));
      return json(res, 201, { category });
    } catch (error) {
      return json(res, categoryErrorStatus(error), { error: categoryErrorMessage(error, "Không tạo được chuyên mục.") });
    }
  }

  const categoryMatch = /^\/api\/admin\/categories\/([^/]+)$/.exec(url.pathname);
  if (categoryMatch && req.method === "PATCH") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = await readJson(req);
      const name = normalizeCategoryName(body.name);
      const category = await mutationConvex(api.categories.update, {
        token: admin.token,
        id: categoryMatch[1],
        name,
      });
      await publishStoriesSite(await queryConvex(api.posts.listAll, { token: admin.token }));
      return json(res, 200, { category });
    } catch (error) {
      return json(res, categoryErrorStatus(error), { error: categoryErrorMessage(error, "Không cập nhật được chuyên mục.") });
    }
  }

  if (categoryMatch && req.method === "DELETE") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      await mutationConvex(api.categories.remove, { token: admin.token, id: categoryMatch[1] });
      await publishStoriesSite(await queryConvex(api.posts.listAll, { token: admin.token }));
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, categoryErrorStatus(error), { error: categoryErrorMessage(error, "Không xóa được chuyên mục.") });
    }
  }

  if (url.pathname === "/api/admin/posts" && req.method === "POST") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const post = normalizePostInput(await readJson(req));
      const id = await mutationConvex(api.posts.create, { token: admin.token, ...post });
      await publishStoriesSite(await queryConvex(api.posts.listAll, { token: admin.token }));
      return json(res, 201, { id });
    } catch (error) {
      return json(res, error.statusCode || 400, { error: errorMessage(error, "Không tạo được bài viết.") });
    }
  }

  const postMatch = /^\/api\/admin\/posts\/([^/]+)$/.exec(url.pathname);
  if (postMatch && req.method === "PATCH") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const post = normalizePostInput(await readJson(req));
      await mutationConvex(api.posts.update, { token: admin.token, id: postMatch[1], ...post });
      await publishStoriesSite(await queryConvex(api.posts.listAll, { token: admin.token }));
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error.statusCode || 400, { error: errorMessage(error, "Không cập nhật được bài viết.") });
    }
  }

  if (postMatch && req.method === "DELETE") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      await mutationConvex(api.posts.remove, { token: admin.token, id: postMatch[1] });
      await publishStoriesSite(await queryConvex(api.posts.listAll, { token: admin.token }));
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: errorMessage(error, "Không xóa được bài viết.") });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/publish-stories") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const posts = await queryConvex(api.posts.listAll, { token: admin.token });
      const result = await publishStoriesSite(posts);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { error: errorMessage(error, "Không xuất bản được stories.") });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/change-password") {
    const admin = await requireAdmin(req, res, { allowPasswordChange: true });
    if (!admin) return;
    try {
      const body = await readJson(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      if (!currentPassword) throw new Error("Vui lòng nhập mật khẩu tạm thời hoặc mật khẩu hiện tại.");
      if (newPassword.length < 8) throw new Error("Mật khẩu mới cần có ít nhất 8 ký tự.");
      if (newPassword === currentPassword) throw new Error("Mật khẩu mới phải khác mật khẩu hiện tại.");
      await mutationConvex(api.adminAuth.changePassword, {
        token: admin.token,
        currentPassword,
        newPassword,
      });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: errorMessage(error, "Không đổi được mật khẩu.") });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/upload") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    try {
      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        return json(res, 415, { error: "Yêu cầu upload dạng multipart/form-data." });
      }
      const body = await readBody(req, MAX_UPLOAD_BYTES);
      const webRequest = new Request(`http://${req.headers.host || "localhost"}${url.pathname}`, {
        method: "POST",
        headers: req.headers,
        body,
      });
      const form = await webRequest.formData();
      const file = form.get("file");
      if (!(file instanceof File) || !file.size) return json(res, 400, { error: "Chưa chọn tệp ảnh." });
      if (file.size > 5_000_000) return json(res, 413, { error: "Ảnh tối đa 5 MB." });

      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
      const extension = extensions[file.type];
      if (!extension) return json(res, 415, { error: "Chỉ nhận JPG, PNG, WebP hoặc GIF." });
      const bytes = Buffer.from(await file.arrayBuffer());
      const validSignature =
        (extension === "jpg" && bytes[0] === 0xff && bytes[1] === 0xd8) ||
        (extension === "png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (extension === "gif" && bytes.subarray(0, 3).toString("ascii") === "GIF") ||
        (extension === "webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP");
      if (!validSignature) return json(res, 415, { error: "Tệp ảnh không hợp lệ." });

      const filename = `${randomUUID()}.${extension}`;
      await writeFile(path.join(UPLOAD_DIR, filename), bytes, { flag: "wx" });
      return json(res, 201, { url: `/uploads/blog/${filename}` });
    } catch (error) {
      return json(res, error.statusCode || 400, { error: errorMessage(error, "Upload thất bại.") });
    }
  }

  return json(res, 404, { error: "API route not found." });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method Not Allowed");
      return (await serveFile(res, path.join(ROOT, "admin.html"))) || text(res, 404, "Not found");
    }

    if (url.pathname.startsWith("/uploads/")) {
      const filePath = path.join(ROOT, "public", url.pathname.replace(/^\/+/, ""));
      const uploadRoot = path.join(ROOT, "public", "uploads");
      if (!filePath.startsWith(uploadRoot + path.sep)) return text(res, 403, "Forbidden");
      return (await serveFile(res, filePath, true)) || text(res, 404, "Not found");
    }

    const staticPath = safeStaticPath(url.pathname);
    if (staticPath && path.extname(staticPath)) {
      const served = await serveFile(res, staticPath, true);
      if (served) return;
    }

    if (staticPath && (req.method === "GET" || req.method === "HEAD")) {
      const servedIndex = await serveFile(res, path.join(staticPath, "index.html"));
      if (servedIndex) return;
    }

    // History API fallback: every public clean route renders the original THE COMMA
    // shell, then the browser router selects the page or loads a Convex article.
    if (req.method === "GET" || req.method === "HEAD") {
      return (await serveFile(res, path.join(ROOT, "index.html"))) || text(res, 404, "Not found");
    }
    return text(res, 405, "Method Not Allowed");
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (!res.headersSent) json(res, status, { error: status === 500 ? "Internal server error." : errorMessage(error) });
    else res.end();
  }
}

const server = http.createServer(handleRequest);
server.keepAliveTimeout = 10_000;
server.headersTimeout = 15_000;

const SCHEDULE_TICK_MS = 30_000;
let scheduleTickBusy = false;

async function storiesNeedRebuild(posts) {
  const publicPosts = publicStories(posts);
  for (const post of publicPosts) {
    try {
      await stat(path.join(ROOT, "stories", post.slug, "index.html"));
    } catch {
      return true;
    }
  }
  try {
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "stories", "story-manifest.json"), "utf8"),
    );
    if (!Array.isArray(manifest) || manifest.length !== publicPosts.length) return true;
  } catch {
    return true;
  }
  return false;
}

async function tickScheduledPublishing() {
  if (!AGENT_PUBLISHING_TOKEN || scheduleTickBusy) return;
  scheduleTickBusy = true;
  try {
    const result = await mutationConvex(api.posts.promoteDueScheduledForAgent, {
      agentToken: AGENT_PUBLISHING_TOKEN,
    });
    const posts = await queryConvex(api.posts.listAllForAgent, {
      agentToken: AGENT_PUBLISHING_TOKEN,
    });
    const promoted = Number(result?.promoted || 0);
    const needsRebuild = promoted > 0 || (await storiesNeedRebuild(posts));
    if (needsRebuild) {
      const site = await publishStoriesSite(posts);
      console.log(
        `Scheduled publishing: promoted=${promoted}` +
          (result?.slugs?.length ? ` [${result.slugs.join(", ")}]` : "") +
          `; static site published=${site.published}`,
      );
    }
  } catch (error) {
    console.error("Scheduled publishing tick failed:", errorMessage(error));
  } finally {
    scheduleTickBusy = false;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`THE COMMA web listening on http://${HOST}:${PORT}`);
  console.log(`Convex local backend configured at ${CONVEX_URL}`);
  tickScheduledPublishing();
  setInterval(tickScheduledPublishing, SCHEDULE_TICK_MS).unref();
});

function shutdown(signal) {
  console.log(`THE COMMA web received ${signal}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
