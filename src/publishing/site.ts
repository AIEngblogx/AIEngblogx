import { type ArticleIndex, slugify } from "../shared/store.ts";
import { rankRecords, tokenize } from "./search.ts";

export const SITE_TITLE = "Blog Translations";

const SOURCE_NAMES: Record<string, string> = {
  "anthropic-engineering": "Anthropic Engineering",
  "openai-engineering": "OpenAI Engineering",
  "google-deepmind": "Google DeepMind",
};

function sourceLabel(name: string): string {
  return (
    SOURCE_NAMES[name] ??
    name
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
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
  title: string;
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
  const pages = index.articles
    .filter((article) => article.status === "published")
    .sort((left, right) => right.published_at.localeCompare(left.published_at))
    .map((article) => ({
      label: article.target_title ? `${article.target_title}（${article.title}）` : article.title,
      title: article.title,
      href: `viewers/${slugify(article.title)}.html`,
      source: article.source,
      date: article.published_at,
      id: article.id,
    }));
  const counts = new Map<string, number>();
  for (const page of pages) counts.set(page.href, (counts.get(page.href) ?? 0) + 1);
  const seen = new Map<string, number>();
  return pages.map((page) => {
    if ((counts.get(page.href) ?? 0) < 2) return page;
    const occurrence = (seen.get(page.href) ?? 0) + 1;
    seen.set(page.href, occurrence);
    return occurrence === 1
      ? page
      : { ...page, href: page.href.replace(/\.html$/, `-${page.id}.html`) };
  });
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
  const ordered = [...groups].sort((left, right) => right[1].length - left[1].length);
  for (const [source, items] of ordered) {
    lines.push(
      `<details class="nav-group" open>`,
      `<summary class="group">${escapeHtml(sourceLabel(source))}</summary>`,
    );
    let number = 0;
    for (const item of items) {
      number += 1;
      const current = item.href === activeHref;
      lines.push(
        `<a class="nav-item${current ? " current" : ""}" href="${prefix}${item.href}"` +
          `${current ? ' aria-current="page"' : ""}>` +
          `<span class="num">${String(number).padStart(2, "0")}</span>${escapeHtml(item.label)}</a>`,
      );
    }
    lines.push("</details>");
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
  color-scheme: light;
  --ink: #111111;
  --muted: #666666;
  --line: #e5e5e5;
  --panel: #fafafa;
  --wash: #f2f2f2;
  --bg: #ffffff;
  --nav-ink: #333333;
  --shadow: rgba(0, 0, 0, 0.12);
  --mark-bg: #fff0a8;
  --mark-ink: #111111;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --ink: #e9e9e9;
  --muted: #9d9d9d;
  --line: #333333;
  --panel: #1a1a1a;
  --wash: #262626;
  --bg: #121212;
  --nav-ink: #d4d4d4;
  --shadow: rgba(0, 0, 0, 0.55);
  --mark-bg: #6b5310;
  --mark-ink: #fff4ce;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--ink); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
::focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
::placeholder { color: var(--muted); opacity: 1; }
.topbar {
  position: fixed; z-index: 3; top: 0; left: 0; right: 0; height: 56px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 0 24px; background: var(--bg); border-bottom: 1px solid var(--line);
}
.crumb { display: flex; flex: 1 1 auto; gap: 8px; align-items: baseline; min-width: 0; font-size: 0.875rem; }
.crumb a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tools { display: flex; flex: 0 0 auto; align-items: center; gap: 16px; font-size: 0.875rem; }
.tools button { white-space: nowrap; }
.search input {
  font: inherit; font-size: 0.875rem; width: 140px; padding: 5px 8px;
  border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--ink);
}
.search-panel {
  position: fixed; z-index: 5; top: 52px; right: 24px; width: 420px;
  max-width: calc(100vw - 32px); max-height: 70vh; overflow-y: auto;
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  box-shadow: 0 8px 28px var(--shadow); padding: 8px;
}
.search-status { padding: 6px 8px; font-size: 0.8rem; color: var(--muted); }
.search-status:empty { display: none; }
.search-hit { display: block; padding: 8px; border-radius: 4px; font-size: 0.875rem; }
.search-hit:hover, .search-hit:focus-visible { background: var(--wash); text-decoration: none; }
.search-hit-title { display: block; font-weight: 600; overflow-wrap: anywhere; }
.search-hit-snippet {
  display: block; margin-top: 4px; color: var(--muted); font-size: 0.8rem;
  line-height: 1.5; overflow-wrap: anywhere;
}
mark { background: var(--mark-bg); color: var(--mark-ink); border-radius: 2px; padding: 0 1px; }
.sidebar {
  position: fixed; z-index: 2; top: 56px; left: 0; bottom: 0; width: 240px;
  overflow-y: auto; background: var(--panel); border-right: 1px solid var(--line);
  padding: 20px 0 48px;
}
.sidebar nav a, .mobile-nav nav a {
  display: block; padding: 6px 20px; font-size: 0.9rem; color: var(--nav-ink); overflow-wrap: anywhere;
}
.sidebar nav a:hover, .mobile-nav nav a:hover { background: var(--wash); text-decoration: none; }
.sidebar nav a.current, .mobile-nav nav a.current { background: var(--wash); font-weight: 600; }
.group { padding: 20px 20px 6px; font-size: 0.8rem; color: var(--muted); }
.nav-group > summary.group { cursor: pointer; list-style: none; }
.nav-group > summary.group::-webkit-details-marker { display: none; }
.nav-group > summary.group::before {
  content: ""; display: inline-block; width: 5px; height: 5px; margin-right: 8px;
  border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted);
  transform: rotate(-45deg); vertical-align: 2px;
}
.nav-group[open] > summary.group::before { transform: rotate(45deg); vertical-align: 1px; }
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
[id^="p-"] { scroll-margin-top: 110px; }
[id^="p-"]:target { background: var(--wash); border-radius: 4px; }
@media (max-width: 900px) {
  .sidebar { display: none; }
  .main { margin-left: 0; padding-top: 96px; }
  .mobile-nav {
    display: block; position: fixed; z-index: 3; top: 56px; left: 0; right: 0;
    background: var(--bg); border-bottom: 1px solid var(--line);
  }
  .mobile-nav summary { padding: 10px 20px; cursor: pointer; font-size: 0.9rem; }
  .mobile-nav nav { max-height: 60vh; overflow-y: auto; padding-bottom: 12px; }
  .bilingual-reader { flex-direction: column; gap: 24px; }
  .pane { max-height: 42vh; }
  body[data-layout="target-source"] .pane-target, body[data-layout="target-source"] .pane-source { order: initial; }
}
@media (max-width: 600px) {
  .crumb span { display: none; }
  .tools { gap: 10px; }
  .search input { width: 92px; }
  .search-panel { left: 12px; right: 12px; width: auto; max-width: none; }
}
@media (prefers-reduced-motion: reduce) {
  .pane { scroll-behavior: auto; }
  .segment { transition: none; }
}
`;

export const THEME_BOOT_JS = `
(function () {
  var theme = "light";
  try {
    var stored = localStorage.getItem("site-theme");
    if (stored === "dark" || stored === "light") theme = stored;
    else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch (error) { theme = "light"; }
  document.documentElement.setAttribute("data-theme", theme);
})();
`;

export const SITE_JS = `
(function () {
  "use strict";
  var tokenize = ${tokenize.toString()};
  var rankRecords = ${rankRecords.toString()};

  var input = document.getElementById("nav-filter");
  var panel = document.getElementById("search-panel");
  var results = document.getElementById("search-results");
  var status = document.getElementById("search-status");
  var prefix = document.body.getAttribute("data-prefix") || "";
  var indexUrl = document.body.getAttribute("data-search-index");
  var cached = null;
  var pending = null;
  var timer = null;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function filterNav(query) {
    var navs = document.querySelectorAll("#site-nav, .mobile-nav nav");
    for (var n = 0; n < navs.length; n++) {
      var groups = navs[n].querySelectorAll(".nav-group");
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        var items = group.querySelectorAll(".nav-item");
        var visible = false;
        for (var i = 0; i < items.length; i++) {
          var match = query === "" || items[i].textContent.toLowerCase().indexOf(query) !== -1;
          items[i].hidden = !match;
          if (match) visible = true;
        }
        group.hidden = query !== "" && !visible;
        if (query !== "" && visible) group.open = true;
      }
    }
  }

  function loadIndex() {
    if (cached !== null) return Promise.resolve(cached);
    if (pending !== null) return pending;
    pending = fetch(prefix + indexUrl)
      .then(function (response) {
        if (!response.ok) throw new Error("index unavailable");
        return response.json();
      })
      .then(function (data) { cached = data; pending = null; return data; })
      .catch(function () { pending = null; return null; });
    return pending;
  }

  function highlight(safeText, needles) {
    if (needles.length === 0) return safeText;
    var lower = safeText.toLowerCase();
    var marks = [];
    for (var i = 0; i < needles.length; i++) {
      var needle = needles[i].toLowerCase();
      if (needle === "") continue;
      var from = 0;
      var at = lower.indexOf(needle, from);
      while (at !== -1) {
        marks.push([at, at + needle.length]);
        from = at + needle.length;
        at = lower.indexOf(needle, from);
      }
    }
    marks.sort(function (left, right) { return left[0] - right[0]; });
    var out = "", cursor = 0;
    for (var m = 0; m < marks.length; m++) {
      var start = marks[m][0], end = marks[m][1];
      if (start < cursor) continue;
      out += safeText.slice(cursor, start) + "<mark>" + safeText.slice(start, end) + "</mark>";
      cursor = end;
    }
    return out + safeText.slice(cursor);
  }

  function snippet(record, query) {
    var target = record[2] || "";
    var source = record[3] || "";
    var lowered = query.toLowerCase();
    var text = target === "" ? source : target;
    if (source !== "" && source.toLowerCase().indexOf(lowered) !== -1) text = source;
    var at = text.toLowerCase().indexOf(lowered);
    if (at === -1) {
      var terms = tokenize(query);
      if (terms.length > 0) at = text.toLowerCase().indexOf(terms[0]);
    }
    var start = at > 60 ? at - 60 : 0;
    var plain = text.slice(start, start + 180);
    var needles = [escapeHtml(query)];
    var queryTerms = tokenize(query).slice(0, 4);
    for (var t = 0; t < queryTerms.length; t++) needles.push(escapeHtml(queryTerms[t]));
    return (start > 0 ? "…" : "") + highlight(escapeHtml(plain), needles) +
      (start + 180 < text.length ? "…" : "");
  }

  function render(data, query) {
    var ranked = rankRecords(data, query, 8);
    var html = "";
    for (var i = 0; i < ranked.length; i++) {
      var record = data.records[ranked[i]];
      var doc = data.documents[record[0]];
      var href = doc.href + (record[1] < 0 ? "" : "#p-" + record[1]);
      html += '<a class="search-hit" href="' + escapeHtml(prefix + href) + '">' +
        '<span class="search-hit-title">' + escapeHtml(doc.title) + "</span>" +
        '<span class="search-hit-snippet">' + snippet(record, query) + "</span></a>";
    }
    results.innerHTML = html;
    status.textContent = ranked.length === 0 ? "No matches" : "";
    panel.hidden = false;
  }

  function run(query) {
    if (query === "" || indexUrl === null || indexUrl === "") {
      panel.hidden = true;
      return;
    }
    status.textContent = cached === null ? "Loading index…" : "";
    panel.hidden = false;
    loadIndex().then(function (data) {
      if (data === null) { panel.hidden = true; status.textContent = ""; return; }
      if (input.value.trim().toLowerCase() !== query) return;
      render(data, query);
    });
  }

  if (input !== null) {
    input.addEventListener("input", function () {
      var query = input.value.trim().toLowerCase();
      filterNav(query);
      clearTimeout(timer);
      timer = setTimeout(function () { run(query); }, 120);
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { panel.hidden = true; input.blur(); }
      else if (event.key === "Enter") {
        var first = results.querySelector(".search-hit");
        if (first !== null) { event.preventDefault(); window.location.href = first.getAttribute("href"); }
      }
    });
    document.addEventListener("click", function (event) {
      if (event.target !== input && !panel.contains(event.target)) panel.hidden = true;
    });
  }

  var themeButton = document.getElementById("theme-toggle");
  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
  function syncTheme() {
    if (themeButton === null) return;
    var dark = isDark();
    var next = dark ? "light" : "dark";
    themeButton.setAttribute("aria-pressed", String(dark));
    themeButton.setAttribute("aria-label", "Switch to " + next + " theme");
    themeButton.setAttribute("title", "Switch to " + next + " theme");
    themeButton.textContent = dark ? "Light" : "Dark";
  }
  if (themeButton !== null) {
    themeButton.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("site-theme", next); } catch (error) { /* storage may be unavailable */ }
      syncTheme();
    });
  }
  syncTheme();
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
  searchIndexHref?: string;
}

export function renderShell(options: ShellOptions): string {
  const nav = renderNav(options.index, options.prefix, options.activeHref);
  const pager = renderPager(options.prefix, options.prev ?? null, options.next ?? null);
  const layout = options.layout === undefined ? "" : ` data-layout="${options.layout}"`;
  const siteTitle = escapeHtml(options.siteTitle ?? SITE_TITLE);
  const footer =
    options.footer ??
    "Translations are provided as-is. See the original article for authoritative wording.";
  const searchIndexHref = escapeHtml(options.searchIndexHref ?? "");
  return `<!doctype html>
<html lang="${escapeHtml(options.language ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>${escapeHtml(options.title)} · ${siteTitle}</title>
<meta name="description" content="Side-by-side translations of public engineering articles">
<style>${SITE_CSS}</style>
<script>${THEME_BOOT_JS}</script>
</head>
<body data-prefix="${escapeHtml(options.prefix)}" data-search-index="${searchIndexHref}"${layout}>
<header class="topbar">
  <div class="crumb"><a href="${options.prefix}index.html">${siteTitle}</a><span>/ ${escapeHtml(options.title)}</span></div>
  <div class="tools">
    <label class="search"><input id="nav-filter" type="search" placeholder="Search articles" aria-label="Search articles" autocomplete="off"></label>
    <button id="theme-toggle" type="button" aria-pressed="false">Dark</button>
    <a href="${options.prefix}rss.xml">RSS</a>
  </div>
</header>
<div class="search-panel" id="search-panel" hidden>
  <div class="search-status" id="search-status" role="status" aria-live="polite"></div>
  <div id="search-results"></div>
</div>
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
