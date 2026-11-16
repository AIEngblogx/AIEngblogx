import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSearchIndex } from "../dist/publishing/search.js";
import { escapeHtml, publishedPages, renderShell } from "../dist/publishing/site.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.argv[2];
const siteUrl = (process.argv[3] ?? "").replace(/\/$/, "");
if (target === undefined) {
  console.error("usage: node scripts/export-site.mjs <outDir> [siteUrl]");
  process.exit(1);
}
const output = resolve(target);
const SITE = "AIEngblogx";
const SITE_URL = "https://aiengblogx.github.io/ai-engineering-related-blogs/";
const SITE_REPO = "https://github.com/AIEngblogx/ai-engineering-related-blogs";
const TOOL_REPO = "https://github.com/AIEngblogx/AIEngblogx";
const SEARCH_INDEX = "search-index.json";
const PUBLIC_SITE_URL = siteUrl === "" ? SITE_URL : `${siteUrl}/`;
const FOOTER =
  `文章版权归原作者所有，译文以英文原文为准。 · ` +
  `<a href="${SITE_REPO}">站点仓库</a> · <a href="${TOOL_REPO}">工具仓库</a>`;

const SOURCE_NAMES = {
  "anthropic-engineering": "Anthropic Engineering",
  "openai-engineering": "OpenAI Engineering",
  "google-deepmind": "Google DeepMind",
  "cohere-blog": "Cohere Blog",
};

const COHERE_NON_ARTICLES = [
  "office", "footprint", "EMEA hub", "APAC hub", "ouvre un bureau", "raises ",
  "valuation", "second close", "funding", "files motion", "lawsuit", "HIPAA",
  "ISO 42001", "certifications", "brand ambassador", "chess champion",
  "early-career researchers", "open research community", "partnership",
  "partners with", "Cohere and ", "Cohere signs", "Cohere expands",
  "Cohere deepens", "Cohere adds", "Cohere achieves", "Connect 2025",
  "10 reasons businesses choose", "AI advantage: How financial institutions",
  "AI customer experience", "advances sovereign", "partner program",
];

function shouldInclude(article) {
  if (article.source !== "cohere-blog") return true;
  const title = article.title.toLowerCase();
  if (COHERE_NON_ARTICLES.some((needle) => title.includes(needle.toLowerCase()))) {
    return false;
  }
  return !/[\uAC00-\uD7AF]/.test(article.title);
}

function sourceLabel(name) {
  return (
    SOURCE_NAMES[name] ??
    name
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanParagraph(text) {
  return String(text).replace(/^(\d{2})(?=[A-Z])/, "$1 ");
}

const BILINGUAL_CSS = `
.pair { margin: 0 0 1.6em; }
.pair .target { margin: 0; overflow-wrap: anywhere; }
.pair .source {
  margin: 0.4em 0 0; padding-left: 12px; border-left: 2px solid var(--line);
  color: var(--muted); font-size: 0.875rem; line-height: 1.65; overflow-wrap: anywhere;
}
body.hide-source .pair .source { display: none; }
.reader-tools { display: flex; align-items: baseline; gap: 16px; margin: 0 0 28px; font-size: 0.875rem; }
`;

function readerTools() {
  return [
    `<style>${BILINGUAL_CSS}</style>`,
    '<div class="reader-tools">',
    '<button id="toggle-source" type="button" aria-pressed="false">隐藏英文原文</button>',
    "</div>",
    "<script>",
    "(function () {",
    '  var button = document.getElementById("toggle-source");',
    "  if (!button) return;",
    '  button.addEventListener("click", function () {',
    '    var hidden = document.body.classList.toggle("hide-source");',
    '    button.setAttribute("aria-pressed", String(hidden));',
    '    button.textContent = hidden ? "显示英文原文" : "隐藏英文原文";',
    "  });",
    "})();",
    "</script>",
  ].join("\n");
}

function imageTag(image) {
  return `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" loading="lazy">`;
}

function trimLeadingNotice(paragraphs) {
  let start = 0;
  while (start < paragraphs.length) {
    const text = paragraphs[start].trim();
    if (/^(?:Announcements(?:[A-Z]|$)|[A-Z][a-z]{2,8} \d{1,2}, \d{4}[A-Z])/.test(text)) {
      start += 1;
    } else break;
  }
  return start === 0 ? paragraphs : paragraphs.slice(start);
}

function trimLeadingNoise(paragraphs) {
  let end = 0;
  while (end < paragraphs.length) {
    const text = paragraphs[end].trim();
    const tocItem = /^\d{2}\s*[A-Z]/.test(text) && text.length <= 120;
    const navLabel = text.length <= 120 && !/[.!?。！？]/.test(text);
    if (tocItem || navLabel) end += 1;
    else break;
  }
  return end >= 3 ? paragraphs.slice(end) : paragraphs;
}

const sourceIndex = JSON.parse(await readFile(join(root, "data", "articles.json"), "utf8"));
const articles = [];
const pendingById = new Map();
for (const article of sourceIndex.articles) {
  if (!shouldInclude(article)) continue;
  let pending;
  try {
    pending = JSON.parse(
      await readFile(join(root, "inbox", "pending", `${article.id}.json`), "utf8"),
    );
  } catch {
    continue;
  }
  const raw = pending.source_paragraphs ?? [];
  const translated = pending.target_paragraphs ?? [];
  // 少于 3 段说明只抓到了标题或页眉，没有正文，先不上站。
  if (raw.length < 3) continue;
  const hasTranslation =
    Array.isArray(pending.target_paragraphs) &&
    translated.length === raw.length &&
    typeof pending.target_language === "string" &&
    pending.target_language !== "";
  if (!hasTranslation) continue;
  articles.push({
    ...article,
    status: "published",
    target_title: typeof pending.target_title === "string" ? pending.target_title : undefined,
  });
  pendingById.set(article.id, pending);
}
if (articles.length === 0) {
  throw new Error("no translated articles with full text in inbox/pending");
}
const index = { schema_version: 2, last_crawled_at: null, articles };
const pages = publishedPages(index);
const sources = new Set(pages.map((page) => page.source));

await mkdir(join(output, "viewers"), { recursive: true });
const keep = new Set(pages.map((page) => page.href.slice("viewers/".length)));
for (const name of await readdir(join(output, "viewers"))) {
  if (name.endsWith(".html") && !keep.has(name)) await rm(join(output, "viewers", name));
}
const searchDocuments = [];

for (let i = 0; i < pages.length; i++) {
  const page = pages[i];
  const pending = pendingById.get(page.id);
  const raw = pending.source_paragraphs ?? [];
  const translated = pending.target_paragraphs ?? [];
  const hasTranslation =
    Array.isArray(pending.target_paragraphs) &&
    translated.length === raw.length &&
    typeof pending.target_language === "string" &&
    pending.target_language !== "";
  const paragraphs = trimLeadingNotice(trimLeadingNoise(raw));
  const skipped = raw.length - paragraphs.length;
  const targetParagraphs = hasTranslation ? translated.slice(skipped) : [];
  searchDocuments.push({
    title: page.label,
    href: page.href,
    paragraphs: paragraphs.map((text, position) => ({
      target: hasTranslation ? (targetParagraphs[position] ?? "") : "",
      source: cleanParagraph(text),
    })),
  });
  const images = pending.images ?? [];
  const byPosition = new Map();
  for (const image of images) {
    const key = Math.max(
      0,
      Math.min((image.before_paragraph ?? 0) - skipped, paragraphs.length),
    );
    const bucket = byPosition.get(key) ?? [];
    bucket.push(image);
    byPosition.set(key, bucket);
  }
  const parts = [];
  if (hasTranslation) parts.push(readerTools());
  for (let position = 0; position <= paragraphs.length; position++) {
    for (const image of byPosition.get(position) ?? []) parts.push(imageTag(image));
    const text = paragraphs[position];
    if (text === undefined) continue;
    if (hasTranslation) {
      parts.push(
        `<div class="pair" id="p-${position}">`,
        `<p class="target" lang="${escapeHtml(pending.target_language)}">${escapeHtml(targetParagraphs[position] ?? "")}</p>`,
        `<p class="source" lang="en">${escapeHtml(cleanParagraph(text))}</p>`,
        "</div>",
      );
    } else {
      parts.push(`<p id="p-${position}">${escapeHtml(cleanParagraph(text))}</p>`);
    }
  }
  const translationNote = hasTranslation
    ? "译文仅作辅助阅读，以英文原文为准。"
    : "本篇暂无中文译文，仅保留英文原文。";
  parts.push(
    "<h2>声明</h2>",
    `<p>公开 AI 工程文章的非官方中英对照归档，${translationNote}` +
      `文章版权归原作者所有。原文：<a href="${escapeHtml(pending.url)}" target="_blank" rel="noopener noreferrer">` +
      `${escapeHtml(pending.url)}</a>。</p>`,
  );
  const previous = pages[i - 1];
  const following = pages[i + 1];
  await writeFile(
    join(output, page.href),
    renderShell({
      title: page.title,
      heading: page.title,
      subline:
        `原文：<a href="${escapeHtml(pending.url)}" target="_blank" rel="noopener noreferrer">` +
        `${escapeHtml(pending.url)}</a> · ${escapeHtml(pending.published_at)} · ${escapeHtml(sourceLabel(page.source))}` +
        (hasTranslation ? " · 中英对照" : ""),
      prefix: "../",
      language: hasTranslation ? pending.target_language : "en",
      searchIndexHref: SEARCH_INDEX,
      activeHref: page.href,
      index,
      content: parts.join("\n"),
      prev: previous === undefined ? null : { label: previous.title, href: previous.href },
      next: following === undefined ? null : { label: following.title, href: following.href },
      siteTitle: SITE,
      footer: FOOTER,
      repoUrl: SITE_REPO,
    }),
    "utf8",
  );
}

const searchIndex = buildSearchIndex(searchDocuments);
await writeFile(join(output, SEARCH_INDEX), JSON.stringify(searchIndex), "utf8");

const list = pages
  .map(
    (page) =>
      `<li><a href="${page.href}">${escapeHtml(page.label)}</a>` +
      `<span class="date">${escapeHtml(page.date)}</span></li>`,
  )
  .join("");
await writeFile(
  join(output, "index.html"),
  renderShell({
    title: "目录",
    heading: "AI 使用与原理",
    subline: `公开工程文章中英对照 · 共 ${pages.length} 篇 · ${sources.size} 个来源`,
    searchIndexHref: SEARCH_INDEX,
    prefix: "",
    activeHref: "index.html",
    index,
    content: [
      `<ul class="post-list">${list}</ul>`,
      '<p><a href="about.html">关于</a> · <a href="rss.xml">RSS</a></p>',
    ].join("\n"),
    siteTitle: SITE,
    footer: FOOTER,
    repoUrl: SITE_REPO,
  }),
  "utf8",
);

await writeFile(
  join(output, "about.html"),
  renderShell({
    title: "关于",
    heading: "关于",
    subline: "非官方中英对照归档",
    searchIndexHref: SEARCH_INDEX,
    prefix: "",
    activeHref: "about.html",
    index,
    content: [
      `<p>收录 AI 实验室公开工程文章中关于怎么用 AI、以及 AI 系统原理的内容，按段落对齐中文译文与英文原文。现有 ${pages.length} 篇，来自 ${sources.size} 个来源；每篇保留原文链接、日期与配图地址。</p>`,
      "<h2>阅读</h2>",
      "<p>译文在上、原文在下，文章页可隐藏英文。搜索索引随站点一起发布，不依赖外部服务；深色模式保存在浏览器本地。</p>",
      "<h2>生成与版权</h2>",
      `<p>页面由 <a href="${TOOL_REPO}">AIEngblogx/AIEngblogx</a> 的 <code>scripts/export-site.mjs</code> 导出。文章、译文与配图权利归原作者，以英文原文为准；<code>LICENSE</code> 仅覆盖页面模板、样式与脚本。勘误与下架请求通过 <a href="${SITE_REPO}/issues">站点仓库 Issue</a> 提交。</p>`,
    ].join("\n"),
    siteTitle: SITE,
    footer: FOOTER,
    repoUrl: SITE_REPO,
  }),
  "utf8",
);

const items = pages.map((page) => {
  const record = articles.find((article) => article.id === page.id);
  const link = siteUrl === "" ? (record?.url ?? page.href) : `${siteUrl}/${page.href}`;
  return [
    "    <item>",
    `      <title>${xmlEscape(page.title)}</title>`,
    `      <link>${xmlEscape(link)}</link>`,
    `      <guid isPermaLink="false">${page.id}</guid>`,
    `      <pubDate>${new Date(`${page.date}T00:00:00Z`).toUTCString()}</pubDate>`,
    `      <description>${xmlEscape(page.title)} · ${xmlEscape(page.date)}</description>`,
    "    </item>",
  ].join("\n");
});
await writeFile(
  join(output, "rss.xml"),
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${xmlEscape(SITE)}</title>`,
    `    <link>${xmlEscape(siteUrl === "" ? "index.html" : siteUrl)}</link>`,
    "    <description>AI 使用与原理相关工程文章的中英对照</description>",
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n"),
  "utf8",
);

await writeFile(join(output, ".nojekyll"), "", "utf8");
await writeFile(
  join(output, "README.md"),
  [
    `# ${SITE}`,
    "",
    `收录 AI 实验室公开工程文章中关于怎么用 AI、以及 AI 系统原理的内容，按段落对齐中文译文与英文原文。目前 ${pages.length} 篇，来自 ${[...sources].sort().map(sourceLabel).join("、")}。`,
    "",
    `站点：[GitHub Pages](${PUBLIC_SITE_URL}) · [站点仓库](${SITE_REPO}) · [工具仓库](${TOOL_REPO})`,
    "",
    "## 生成",
    "",
    `页面由 [AIEngblogx/AIEngblogx](${TOOL_REPO}) 的 \`scripts/export-site.mjs\` 从本机抓取数据导出，文章数据不入库。`,
    "",
    "```bash",
    "npm ci",
    "npm run build",
    "node dist/main.js crawl --json",
    "node dist/main.js translate --model <model> --lang zh-CN --json",
    "node scripts/translate-titles.mjs <model>",
    `node scripts/export-site.mjs ../ai-engineering-related-blogs ${PUBLIC_SITE_URL}`,
    "```",
    "",
    "第二个参数是站点 URL，用于生成 RSS 绝对链接。导出只收录译文完整且正文不少于 3 段的文章，并清理上一版不再收录的页面。",
    "",
    "## 版权",
    "",
    "文章、译文与配图权利归原作者，以英文原文为准。`LICENSE` 仅覆盖页面模板、样式与脚本。勘误与下架请求通过仓库 Issue 提交。",
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  `exported ${pages.length} articles from ${sources.size} sources to ${output} ` +
    `(${searchIndex.records.length} indexed records, ${Object.keys(searchIndex.postings).length} terms)`,
);
