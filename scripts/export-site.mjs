import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const FOOTER =
  "本站为公开 AI 工程博客的非官方中英对照归档。中文译文仅作辅助阅读，请以英文原文为准；文章内容版权归原作者所有。";

function sourceLabel(name) {
  return name
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
.reader-tools .hint { color: var(--muted); }
`;

function readerTools() {
  return [
    `<style>${BILINGUAL_CSS}</style>`,
    '<div class="reader-tools">',
    '<button id="toggle-source" type="button" aria-pressed="false">隐藏英文原文</button>',
    '<span class="hint">中文译文在上，英文原文在下</span>',
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
  const hasTranslation =
    raw.length > 0 &&
    Array.isArray(pending.target_paragraphs) &&
    translated.length === raw.length &&
    typeof pending.target_language === "string" &&
    pending.target_language !== "";
  if (!hasTranslation) continue;
  articles.push({ ...article, status: "published" });
  pendingById.set(article.id, pending);
}
if (articles.length === 0) {
  throw new Error("no translated articles in inbox/pending");
}
const index = { schema_version: 2, last_crawled_at: null, articles };
const pages = publishedPages(index);
const sources = new Set(pages.map((page) => page.source));

await mkdir(join(output, "viewers"), { recursive: true });
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
      title: page.label,
      heading: page.label,
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
      prev: previous === undefined ? null : { label: previous.label, href: previous.href },
      next: following === undefined ? null : { label: following.label, href: following.href },
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
    subline: `目前收录 ${pages.length} 篇公开工程文章的中英对照`,
    searchIndexHref: SEARCH_INDEX,
    prefix: "",
    activeHref: "index.html",
    index,
    content: [
      `<p>本站收录 ${pages.length} 篇公开工程文章的中英对照阅读。每篇按段落给出中文译文与英文原文，正文与配图按原顺序保留，并可用页内按钮隐藏英文原文。顶部搜索框可全文检索中文译文与英文原文，右上角可切换深色 / 浅色主题。中文译文仅作辅助阅读，请以英文原文为准。</p>`,
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
      "<p>本站是公开 AI 工程博客的非官方中英对照归档，按来源分组供阅读与检索使用。文章版权归原作者所有，每篇都保留原文链接与发布日期。</p>",
      "<h2>内容</h2>",
      `<p>目前收录 ${pages.length} 篇。每篇按段落给出中文译文与英文原文，可点击页内按钮隐藏英文原文；配图引用原文地址（不下载图片文件）。中文译文仅作辅助阅读，请以英文原文为准。</p>`,
      "<h2>搜索</h2>",
      "<p>顶部搜索框使用预生成的倒排索引，中文按二元切分、英文按单词切分，以词频与逆文档频率（TF-IDF）打分排序；结果直接跳到命中的段落。索引文件为 <code>search-index.json</code>，首次输入时按需加载，站点不依赖任何外部搜索服务。</p>",
      "<h2>主题</h2>",
      "<p>右上角按钮可在深色与浅色主题间切换，首次访问跟随系统偏好，选择会保存在本地浏览器中。</p>",
      "<h2>生成</h2>",
      '<p>页面由工具仓库 <a href="https://github.com/AIEngblogx/AIEngblogx">AIEngblogx/AIEngblogx</a> 的 <code>scripts/export-site.mjs</code> 从抓取数据生成，请勿手工编辑 HTML。</p>',
      "<h2>版权与下架</h2>",
      "<p>文章正文、译文与配图的权利归原作者所有，本仓库的 LICENSE 只覆盖页面模板、样式与脚本。如需下架某篇或修正译文，请在本仓库提交 Issue，注明文章链接与原因。</p>",
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
    `      <title>${xmlEscape(page.label)}</title>`,
    `      <link>${xmlEscape(link)}</link>`,
    `      <guid isPermaLink="false">${page.id}</guid>`,
    `      <pubDate>${new Date(`${page.date}T00:00:00Z`).toUTCString()}</pubDate>`,
    `      <description>${xmlEscape(page.label)} · ${xmlEscape(page.date)}</description>`,
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
    `公开 AI 工程博客的中英对照阅读站，目前收录 ${pages.length} 篇，持续补充。页面由工具仓库生成，可直接用 GitHub Pages 托管。`,
    "",
    "## 部署",
    "",
    "1. 仓库 Settings → Pages → Deploy from a branch → `main` / `(root)`。",
    "2. 站点地址：`https://aiengblogx.github.io/ai-engineering-related-blogs/`。",
    "3. 若实际地址不同，重新导出时把它作为第二个参数传入，以修正 RSS 链接。",
    "",
    "## 内容",
    "",
    "| 路径 | 内容 |",
    "|---|---|",
    "| `index.html` | 书目录（按来源分组的左侧目录、顶部全文搜索、篇末翻页） |",
    "| `viewers/*.html` | 文章页，逐段中英对照（可切换隐藏英文原文）、原文配图、原文链接与日期 |",
    "| `about.html` | 声明、搜索、主题与版权说明 |",
    "| `search-index.json` | 全文搜索用的倒排索引，首次搜索时加载 |",
    "| `rss.xml` | 订阅 |",
    "",
    "## 站点生成",
    "",
    "页面由 [AIEngblogx/AIEngblogx](https://github.com/AIEngblogx/AIEngblogx) 的",
    "`scripts/export-site.mjs` 从抓取数据生成，请勿手工编辑 HTML。工具仓库只包含代码；",
    "文章数据留在本机，不入库。复现步骤见工具仓库 README 与 CONTRIBUTING。",
    "只有已完成译文的文章会被导出。",
    "",
    "## 版权与内容",
    "",
    "文章正文、译文与配图的权利归原作者所有，本仓库 `LICENSE` 只覆盖页面模板、样式与脚本。",
    "本站为非官方归档，每篇保留原文链接与发布日期；中文译文仅作辅助阅读，请以英文原文为准。",
    "如需下架某篇或修正译文，请在本仓库提交 Issue，注明文章链接与原因。",
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  `exported ${pages.length} articles from ${sources.size} sources to ${output} ` +
    `(${searchIndex.records.length} indexed records, ${Object.keys(searchIndex.postings).length} terms)`,
);
