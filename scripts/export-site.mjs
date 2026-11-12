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
const SEARCH_INDEX = "search-index.json";
const FOOTER = "文章版权归原作者所有，译文请以英文原文为准。";

const SOURCE_NAMES = {
  "anthropic-engineering": "Anthropic Engineering",
  "openai-engineering": "OpenAI Engineering",
  "google-deepmind": "Google DeepMind",
};

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
    ? "中文译文仅作辅助阅读，请以英文原文为准；发现错译欢迎提交 Issue 勘误。"
    : "本篇暂无中文译文，仅保留英文原文。";
  parts.push(
    "<h2>声明</h2>",
    `<p>本文为公开 AI 工程博客文章的非官方中英对照归档，${translationNote}` +
      `文章版权归原作者所有。原文链接：<a href="${escapeHtml(pending.url)}" target="_blank" rel="noopener noreferrer">` +
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
    heading: "AI 工程博客中英对照",
    subline: `共 ${pages.length} 篇 · ${sources.size} 个来源`,
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
      `<p>这里收的是 AI 实验室公开工程文章的中英对照，按段落对齐，现在有 ${pages.length} 篇，来自 ${sources.size} 个来源。每篇开头都留了原文链接和日期，配图直接引用原文地址。</p>`,
      "<h2>读法</h2>",
      "<p>中文在上、英文在下，点「隐藏英文原文」可以只留中文。顶部搜索用的是预先生成的索引，不依赖外部服务；右上角切深色，选择存在浏览器里。译文以英文原文为准，译错的地方开个 issue 说哪篇哪段就行。</p>",
      "<h2>生成与版权</h2>",
      '<p>页面由 <a href="https://github.com/AIEngblogx/AIEngblogx">AIEngblogx/AIEngblogx</a> 的 <code>scripts/export-site.mjs</code> 导出。文章、译文和配图的权利归原作者，仓库里的 LICENSE 只管模板和脚本。</p>',
    ].join("\n"),
    siteTitle: SITE,
    footer: FOOTER,
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
    "    <description>公开 AI 工程博客中英对照</description>",
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
    `AI 工程博客的中英对照阅读站，按段落对齐原文与译文。收录 ${[...sources].sort().map(sourceLabel).join("、")} 的公开文章，目前 ${pages.length} 篇。`,
    "",
    "站点：https://aiengblogx.github.io/ai-engineering-related-blogs/（GitHub Pages，从 `main` 根目录发布）。侧边栏按来源分组、可折叠；文章页支持全文检索与隐藏英文原文。译文以英文原文为准。",
    "",
    "## 生成",
    "",
    "页面由 [AIEngblogx/AIEngblogx](https://github.com/AIEngblogx/AIEngblogx) 导出，抓取、翻译与生成在本机完成，文章数据不入库。",
    "",
    "```bash",
    "npm ci",
    "npm run build",
    "node dist/main.js crawl --json",
    "node dist/main.js translate --model <model> --lang zh-CN --json",
    "node scripts/translate-titles.mjs <model>",
    "node scripts/export-site.mjs ../ai-engineering-related-blogs https://aiengblogx.github.io/ai-engineering-related-blogs",
    "```",
    "",
    "第二个参数是站点 URL，写入 RSS 链接。导出只收录有译文且正文完整的文章，并清理上一版不再收录的页面。",
    "",
    "## 版权",
    "",
    "文章、译文与配图权利归原作者。仓库 `LICENSE` 覆盖模板、样式与脚本。勘误与下架请求通过仓库 Issue 提交。",
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  `exported ${pages.length} articles from ${sources.size} sources to ${output} ` +
    `(${searchIndex.records.length} indexed records, ${Object.keys(searchIndex.postings).length} terms)`,
);
