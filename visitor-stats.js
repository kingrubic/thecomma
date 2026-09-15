const statsRoot = document.createElement("section");
statsRoot.className = "visitor-stats";
statsRoot.setAttribute("aria-label", "Thống kê truy cập");
statsRoot.innerHTML = `
  <p>Visitor statistics</p>
  <dl>
    <div><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>Page views 30 days</dt><dd data-stat="totalVisits">—</dd><i>||</i></div>
    <div><dt><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v3M19 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z"/></svg>Page views today</dt><dd data-stat="todayVisits">—</dd><i>||</i></div>
    <div><dt><span aria-hidden="true"></span>Online</dt><dd data-stat="onlineVisitors">—</dd></div>
  </dl>`;

const style = document.createElement("style");
style.textContent = `
  .visitor-stats{box-sizing:border-box;width:min(1180px,calc(100% - 44px));margin:0 auto;padding:28px 0;color:inherit;border-top:1px solid rgba(255,255,255,.14);font-family:inherit}
  .visitor-stats>p{margin:0 0 12px;color:rgba(255,255,255,.55);font-size:10px;font-weight:650;letter-spacing:.22em;text-transform:uppercase}
  .visitor-stats dl,.visitor-stats dl>div,.visitor-stats dt{display:inline-flex;align-items:center;flex-wrap:wrap}
  .visitor-stats dl{gap:8px 12px;margin:0;color:rgba(255,255,255,.72);font-size:12px}
  .visitor-stats dl>div{gap:8px}.visitor-stats dt{gap:6px}.visitor-stats dd{margin:0;color:#fff;font-size:15px;font-weight:700}
  .visitor-stats svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.6}.visitor-stats i{color:rgba(255,255,255,.28);font-style:normal}
  .visitor-stats dt>span{width:8px;height:8px;border-radius:50%;background:#d2ae70;box-shadow:0 0 12px rgba(210,174,112,.55)}
  @media(max-width:600px){.visitor-stats{width:calc(100% - 44px)}.visitor-stats dl{display:flex}.visitor-stats i{display:none}}
`;
document.head.append(style);

const formatCount = (value) => new Intl.NumberFormat("en-US").format(Number(value) || 0);
let lastPath = "";

function mountStats() {
  const footer = document.querySelector("#app footer") || document.querySelector("footer");
  if (footer && statsRoot.parentElement !== footer) footer.append(statsRoot);
}

function renderStats(stats) {
  for (const key of ["totalVisits", "todayVisits", "onlineVisitors"]) {
    const node = statsRoot.querySelector(`[data-stat="${key}"]`);
    if (node) node.textContent = formatCount(stats?.[key]);
  }
}

async function syncStats(event) {
  const response = await fetch("/api/visitor-stats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
    cache: "no-store",
    keepalive: event === "heartbeat",
  });
  if (response.ok) renderStats(await response.json());
}

function recordCurrentPath() {
  mountStats();
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  void syncStats("pageview");
}

new MutationObserver(recordCurrentPath).observe(document.body, { childList: true, subtree: true });
window.addEventListener("popstate", () => setTimeout(recordCurrentPath));
window.addEventListener("hashchange", () => setTimeout(recordCurrentPath));
setInterval(() => void syncStats("heartbeat"), 60_000);
recordCurrentPath();
