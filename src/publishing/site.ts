import { type ArticleIndex, slugify } from "../shared/store.ts";

export const SITE_TITLE = "Blog Translations";

function sourceLabel(name: string): string {
  return name
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PublishedPage {
  label: string;
  href: string;
  source: string;
  date: string;
  id: string;
}

export interface PageLink {
  label: string;
  href: string;
}

export function publishedPages(index: ArticleIndex): PublishedPage[] {
  return index.articles
    .filter((article) => article.status === "published")
    .sort((left, right) => right.published_at.localeCompare(left.published_at))
    .map((article) => ({
      label: article.title,
      href: `viewers/${slugify(article.title)}.html`,
      source: article.source,
      date: article.published_at,
      id: article.id,
    }));
}

export function renderNav(index: ArticleIndex, prefix: string, activeHref: string): string {
  const pages = publishedPages(index);
  const lines: string[] = [];
  const topLinks: [string, string][] = [
    ["Contents", "index.html"],
    ["About", "about.html"],
  ];
  for (const [label, href] of topLinks) {
    const current = href === activeHref;
    lines.push(
      `<a href="${prefix}${href}"${current ? ' aria-current="page" class="current"' : ""}>${escapeHtml(label)}</a>`,
    );
  }
  lines.push(`<a href="${prefix}rss.xml">RSS</a>`);

  const groups = new Map<string, PublishedPage[]>();
  for (const page of pages) {
    const bucket = groups.get(page.source) ?? [];
    bucket.push(page);
    groups.set(page.source, bucket);
  }
  let number = 0;
  for (const [source, items] of groups) {
    lines.push(`<div class="group">${escapeHtml(sourceLabel(source))}</div>`);
    for (const item of items) {
      number += 1;
      const current = item.href === activeHref;
      lines.push(
        `<a class="nav-item${current ? " current" : ""}" href="${prefix}${item.href}"` +
          `${current ? ' aria-current="page"' : ""}>` +
          `<span class="num">${String(number).padStart(2, "0")}</span>${escapeHtml(item.label)}</a>`,
      );
    }
  }
  if (pages.length === 0) lines.push('<p class="empty">No published articles yet.</p>');
  return lines.join("\n");
}

export function renderPager(prefix: string, prev: PageLink | null, next: PageLink | null): string {
  if (prev === null && next === null) return "";
  const left =
    prev === null
      ? "<span></span>"
      : `<a href="${prefix}${prev.href}">← ${escapeHtml(prev.label)}</a>`;
  const right =
    next === null
      ? "<span></span>"
      : `<a href="${prefix}${next.href}">${escapeHtml(next.label)} →</a>`;
  return `<nav class="pager" aria-label="Previous and next">${left}${right}</nav>`;
}

export const SITE_CSS = `
:root {
  --ink: #111111;
  --muted: #666666;
  --line: #e5e5e5;
  --panel: #fafafa;
  --wash: #f2f2f2;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  background: #ffffff;
  color: var(--ink);
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--ink); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.topbar {
  position: fixed; z-index: 3; top: 0; left: 0; right: 0; height: 56px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 0 24px; background: #ffffff; border-bottom: 1px solid var(--line);
}
.crumb { display: flex; gap: 8px; align-items: baseline; min-width: 0; font-size: 0.875rem; }
.crumb span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tools { display: flex; align-items: center; gap: 16px; font-size: 0.875rem; }
.search input {
  font: inherit; font-size: 0.875rem; width: 140px; padding: 5px 8px;
  border: 1px solid var(--line); border-radius: 4px; background: #ffffff; color: var(--ink);
}
.sidebar {
  position: fixed; z-index: 2; top: 56px; left: 0; bottom: 0; width: 240px;
  overflow-y: auto; background: var(--panel); border-right: 1px solid var(--line);
  padding: 20px 0 48px;
}
.sidebar nav a, .mobile-nav nav a {
  display: block; padding: 6px 20px; font-size: 0.9rem; color: #333333; overflow-wrap: anywhere;
}
.sidebar nav a:hover, .mobile-nav nav a:hover { background: var(--wash); text-decoration: none; }
.sidebar nav a.current, .mobile-nav nav a.current { background: var(--wash); font-weight: 600; }
.group { padding: 20px 20px 6px; font-size: 0.8rem; color: var(--muted); }
.num { display: inline-block; min-width: 26px; font-size: 0.8rem; color: var(--muted); }
.empty { padding: 12px 20px; font-size: 0.875rem; color: var(--muted); }
.post-list { list-style: none; padding: 0; margin: 0 0 24px; }
.post-list li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.post-list .date { margin-left: 8px; font-size: 0.875rem; color: var(--muted); }
.mobile-nav { display: none; }
.main { margin-left: 240px; padding-top: 56px; min-width: 0; }
.page { max-width: 780px; margin: 0 auto; padding: 48px 32px 96px; }
h1 { font-size: 2rem; line-height: 1.25; margin: 0 0 8px; font-weight: 650; overflow-wrap: anywhere; }
h2 { font-size: 1.2rem; margin: 36px 0 12px; font-weight: 650; }
.subline { margin: 0; font-size: 0.875rem; color: var(--muted); overflow-wrap: anywhere; }
.divider { border-top: 1px solid var(--line); margin: 24px 0 32px; }
p { margin: 0 0 1.25em; }
img { display: block; max-width: 100%; height: auto; margin: 0 0 24px; }
table { width: 100%; border-collapse: collapse; margin: 0 0 24px; font-size: 0.9rem; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.toolbar { display: flex; align-items: baseline; gap: 16px; margin-bottom: 16px; }
button {
  font: inherit; padding: 0; border: 0; background: none; color: var(--ink);
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
button:hover { text-decoration-thickness: 2px; }
.status { font-size: 0.875rem; color: var(--muted); }
.bilingual-reader { display: flex; gap: 40px; }
.pane { flex: 1 1 0; min-width: 0; max-height: 78vh; overflow-y: auto; scroll-behavior: smooth; }
body[data-layout="target-source"] .pane-target { order: 1; }
body[data-layout="target-source"] .pane-source { order: 2; }
.segment {
  padding: 4px 0 4px 10px; border-left: 2px solid transparent;
  cursor: pointer; overflow-wrap: anywhere; transition: background 0.15s;
}
.segment:hover { background: var(--wash); }
.segment.active { background: var(--wash); border-left-color: var(--ink); font-weight: 600; }
.pager {
  display: flex; justify-content: space-between; gap: 16px; margin-top: 64px;
  padding-top: 16px; border-top: 1px solid var(--line); font-size: 0.9rem;
}
.pager a { overflow-wrap: anywhere; }
.footer {
  margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line);
  font-size: 0.875rem; color: var(--muted);
}
@media (max-width: 900px) {
  .sidebar { display: none; }
  .main { margin-left: 0; padding-top: 96px; }
  .mobile-nav {
    display: block; position: fixed; z-index: 3; top: 56px; left: 0; right: 0;
    background: #ffffff; border-bottom: 1px solid var(--line);
  }
  .mobile-nav summary { padding: 10px 20px; cursor: pointer; font-size: 0.9rem; }
  .mobile-nav nav { max-height: 60vh; overflow-y: auto; padding-bottom: 12px; }
  .bilingual-reader { flex-direction: column; gap: 24px; }
  .pane { max-height: 42vh; }
  body[data-layout="target-source"] .pane-target, body[data-layout="target-source"] .pane-source { order: initial; }
}
@media (max-width: 600px) {
  .search, .crumb span { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .pane { scroll-behavior: auto; }
  .segment { transition: none; }
}
`;

export const SITE_JS = `
(function () {
  "use strict";
  var input = document.getElementById("nav-filter");
  if (!input) return;
  input.addEventListener("input", function () {
    var query = input.value.trim().toLowerCase();
    var navs = document.querySelectorAll("#site-nav, .mobile-nav nav");
    for (var n = 0; n < navs.length; n++) {
      var nav = navs[n];
      var items = nav.querySelectorAll(".nav-item");
      for (var i = 0; i < items.length; i++) {
        items[i].hidden = query !== "" && items[i].textContent.toLowerCase().indexOf(query) === -1;
      }
      var groups = nav.querySelectorAll(".group");
      for (var g = 0; g < groups.length; g++) {
        var sibling = groups[g].nextElementSibling;
        var visible = false;
        while (sibling !== null && sibling.classList.contains("nav-item")) {
          if (!sibling.hidden) visible = true;
          sibling = sibling.nextElementSibling;
        }
        groups[g].hidden = query !== "" && !visible;
      }
    }
  });
})();
`;

export interface ShellOptions {
  title: string;
  heading: string;
  subline: string;
  prefix: string;
  activeHref: string;
  index: ArticleIndex;
  content: string;
  prev?: PageLink | null;
  next?: PageLink | null;
  layout?: "source-target" | "target-source";
  language?: string;
  siteTitle?: string;
  footer?: string;
}

export function renderShell(options: ShellOptions): string {
  const nav = renderNav(options.index, options.prefix, options.activeHref);
  const pager = renderPager(options.prefix, options.prev ?? null, options.next ?? null);
  const layout = options.layout === undefined ? "" : ` data-layout="${options.layout}"`;
  const siteTitle = escapeHtml(options.siteTitle ?? SITE_TITLE);
  const footer =
    options.footer ??
    "Translations are provided as-is. See the original article for authoritative wording.";
  return `<!doctype html>
<html lang="${escapeHtml(options.language ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · ${siteTitle}</title>
<meta name="description" content="Side-by-side translations of public engineering articles">
<style>${SITE_CSS}</style>
</head>
<body${layout}>
<header class="topbar">
  <div class="crumb"><a href="${options.prefix}index.html">${siteTitle}</a><span>/ ${escapeHtml(options.title)}</span></div>
  <div class="tools">
    <label class="search"><input id="nav-filter" type="search" placeholder="Filter articles" aria-label="Filter articles" autocomplete="off"></label>
    <a href="${options.prefix}rss.xml">RSS</a>
  </div>
</header>
<aside class="sidebar"><nav id="site-nav" aria-label="Contents">${nav}</nav></aside>
<details class="mobile-nav"><summary>Contents</summary><nav aria-label="Contents">${nav}</nav></details>
<main class="main"><article class="page">
  <h1>${escapeHtml(options.heading)}</h1>
  <p class="subline">${options.subline}</p>
  <div class="divider"></div>
  ${options.content}
  ${pager}
  <footer class="footer">${footer}</footer>
</article></main>
<script>${SITE_JS}</script>
</body>
</html>
`;
}
