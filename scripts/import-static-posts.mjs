import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(ROOT, "stories", "story-manifest.json"), "utf8"));
const categoryNames = {
  coffee: "Cà phê",
  tea: "Trà",
  matcha: "Matcha",
  season: "Món theo mùa",
};

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function inlineMarkdown(value) {
  return decodeHtml(String(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim());
}

function articleContent(html) {
  const body = /<div class="article-body">([\s\S]*?)<\/div>\s*<aside/i.exec(html)?.[1] || "";
  const blocks = [];
  for (const match of body.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = match[1].toLowerCase();
    const text = inlineMarkdown(match[2]);
    if (!text) continue;
    blocks.push(tag.startsWith("h") ? `${"#".repeat(Number(tag.slice(1)))} ${text}` : tag === "li" ? `- ${text}` : text);
  }
  if (!blocks.length) throw new Error("Không đọc được article-body từ HTML.");
  return blocks.join("\n\n");
}

function tagsFromHtml(html) {
  const ingredients = /<div class="article-ingredients">([\s\S]*?)<\/div>/i.exec(html)?.[1];
  return ingredients
    ? [...ingredients.matchAll(/<span>([\s\S]*?)<\/span>/gi)].map((match) => inlineMarkdown(match[1])).filter(Boolean)
    : [];
}

const posts = [];
for (const item of manifest) {
  const html = await readFile(path.join(ROOT, "stories", item.slug, "index.html"), "utf8");
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(html)?.[1];
  let publishedAt = Date.parse("2026-07-27T12:00:00+07:00");
  try {
    const parsed = JSON.parse(jsonLd);
    const graph = parsed["@graph"] || [parsed];
    const article = graph.find((entry) => entry["@type"] === "BlogPosting");
    if (article?.datePublished) publishedAt = Date.parse(`${article.datePublished}T12:00:00+07:00`);
  } catch { /* fall back to the site's initial publication date */ }
  const image = String(item.image || "").replace(/^\/+/, "");
  posts.push({
    title: item.title,
    slug: item.slug,
    excerpt: item.meta_description || item.title,
    content: articleContent(html),
    ...(image ? { coverImage: `/${image}` } : {}),
    category: categoryNames[item.category] || item.category,
    tags: tagsFromHtml(html),
    author: "THE COMMA",
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
  });
}

const payloadPath = path.join(ROOT, ".static-post-import.json");
await writeFile(payloadPath, `${JSON.stringify({ posts })}\n`, { mode: 0o600 });
try {
  const args = ["convex", "run", "migrations:importStaticPosts", JSON.stringify({ posts }), "--push"];
  const output = execFileSync("npx", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(output);
} finally {
  await import("node:fs/promises").then(({ unlink }) => unlink(payloadPath).catch(() => {}));
}
