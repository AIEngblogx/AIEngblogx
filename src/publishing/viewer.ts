import { join } from "node:path";
import { appendLog, messageOf } from "../shared/log.ts";
import {
  listPendingIds,
  loadIndex,
  loadPending,
  type PendingArticle,
  slugify,
  writeTextAtomic,
} from "../shared/store.ts";
import { escapeHtml, type PageLink, publishedPages, renderShell } from "./site.ts";

export interface ViewerOptions {
  article?: string;
  layout: "source-target" | "target-source";
}

export interface ViewerResult {
  built: number;
  skipped: number;
  failed: number;
}

const MAX_VIEWER_BYTES = 200 * 1024;

const VIEWER_FRAGMENT = `<div class="toolbar">
  <button type="button" id="swap">Swap columns</button>
  <span class="status" id="status" role="status" aria-live="polite"></span>
</div>
<div class="bilingual-reader" id="reader">
  <div class="pane pane-source" id="pane-source" tabindex="0" aria-label="Source text"></div>
  <div class="pane pane-target" id="pane-target" tabindex="0" aria-label="Translation"></div>
</div>
<section class="figures" id="figures" hidden>
  <h2>Figures</h2>
  <div id="figure-list"></div>
</section>
<script>window.__SEGMENTS__ = {{segments_json}};</script>
<script>window.__IMAGES__ = {{images_json}};</script>
<script>
(function () {
  "use strict";
  var segments = window.__SEGMENTS__ || [];
  var images = window.__IMAGES__ || [];
  var panes = { source: document.getElementById("pane-source"), target: document.getElementById("pane-target") };
  var status = document.getElementById("status");
  var statusTimer;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function render(pane, key) {
    pane.innerHTML = segments.map(function (segment) {
      var label = (key === "source" ? "Source " : "Translation ") + (segment.index + 1);
      return '<div class="segment" data-index="' + segment.index + '" tabindex="0" role="button" aria-label="' +
        label + '"><span class="text">' + escapeHtml(segment[key]) + "</span></div>";
    }).join("");
  }

  function renderFigures() {
    var list = document.getElementById("figure-list");
    for (var i = 0; i < images.length; i++) {
      var item = images[i] || {};
      var parsed;
      try { parsed = new URL(String(item.url || ""), window.location.href); } catch (error) { continue; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      var image = document.createElement("img");
      image.src = parsed.toString();
      image.alt = String(item.alt || "");
      image.loading = "lazy";
      list.appendChild(image);
    }
    if (list.childNodes.length > 0) document.getElementById("figures").hidden = false;
  }

  function showStatus(message) {
    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { status.textContent = ""; }, 1600);
  }

  function fallbackCopy(text) {
    var field = document.createElement("textarea");
    field.value = text;
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand("copy");
      showStatus("Copied");
    } catch (error) {
      showStatus("Copy failed; select the text manually");
    }
    document.body.removeChild(field);
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showStatus("Copied"); },
        function () { fallbackCopy(text); }
      );
    } else {
      fallbackCopy(text);
    }
  }

  function highlight(index) {
    var active = document.querySelectorAll(".segment.active");
    for (var i = 0; i < active.length; i++) active[i].classList.remove("active");
    var pair = document.querySelectorAll('.segment[data-index="' + index + '"]');
    for (var j = 0; j < pair.length; j++) pair[j].classList.add("active");
  }

  function bindHighlight(pane) {
    pane.addEventListener("mouseover", function (event) {
      var segment = event.target.closest(".segment");
      if (segment) highlight(segment.dataset.index);
    });
    pane.addEventListener("focusin", function (event) {
      var segment = event.target.closest(".segment");
      if (segment) highlight(segment.dataset.index);
    });
    pane.addEventListener("click", function (event) {
      var segment = event.target.closest(".segment");
      if (segment) copy(segment.querySelector(".text").textContent);
    });
  }

  var syncing = false;
  function syncScroll(source, destination) {
    var maxSource = source.scrollHeight - source.clientHeight;
    var maxDestination = destination.scrollHeight - destination.clientHeight;
    if (maxSource <= 0 || maxDestination <= 0) return;
    destination.scrollTop = (source.scrollTop / maxSource) * maxDestination;
  }
  function bindScroll(source, destination) {
    source.addEventListener("scroll", function () {
      if (syncing) return;
      syncing = true;
      requestAnimationFrame(function () {
        syncScroll(source, destination);
        requestAnimationFrame(function () { syncing = false; });
      });
    });
  }

  document.addEventListener("keydown", function (event) {
    var focused = document.activeElement;
    if (!focused || !focused.closest) return;
    var segment = focused.closest(".segment");
    if (!segment) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      var sibling = event.key === "ArrowDown" ? segment.nextElementSibling : segment.previousElementSibling;
      if (sibling) sibling.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      copy(segment.querySelector(".text").textContent);
    }
  });

  var swap = document.getElementById("swap");
  var stored = null;
  try { stored = localStorage.getItem("reader-layout"); } catch (error) { stored = null; }
  if (stored === "source-target" || stored === "target-source") document.body.dataset.layout = stored;
  swap.addEventListener("click", function () {
    var next = document.body.dataset.layout === "target-source" ? "source-target" : "target-source";
    document.body.dataset.layout = next;
    try { localStorage.setItem("reader-layout", next); } catch (error) { /* storage may be unavailable */ }
  });

  render(panes.source, "source");
  render(panes.target, "target");
  renderFigures();
  bindHighlight(panes.source);
  bindHighlight(panes.target);
  bindScroll(panes.source, panes.target);
  bindScroll(panes.target, panes.source);
})();
</script>
`;

export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export async function renderViewer(
  root: string,
  article: PendingArticle,
  layout: "source-target" | "target-source",
): Promise<string> {
  const content = VIEWER_FRAGMENT.replaceAll(
    "{{segments_json}}",
    safeJson(article.segments),
  ).replaceAll("{{images_json}}", safeJson(article.images ?? []));
  const index = await loadIndex(root);
  const pages = publishedPages(index);
  const slug = slugify(article.title);
  const activeHref = `viewers/${slug}.html`;
  const position = pages.findIndex((page) => page.href === activeHref);
  const previous = pages[position - 1];
  const following = pages[position + 1];
  const prev: PageLink | null =
    previous === undefined ? null : { label: previous.label, href: previous.href };
  const next: PageLink | null =
    position < 0 || following === undefined
      ? null
      : { label: following.label, href: following.href };
  const html = renderShell({
    title: article.title,
    heading: article.title,
    subline:
      `Original: <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">` +
      `${escapeHtml(article.url)}</a> · ${escapeHtml(article.published_at)} · ` +
      `${escapeHtml(article.source)} · <a href="../posts/${slug}.html">Translation</a> · ` +
      `<a href="../index.html">Contents</a>`,
    prefix: "../",
    activeHref,
    index,
    content,
    prev,
    next,
    layout,
    language: article.target_language || "en",
  });
  if (Buffer.byteLength(html, "utf8") > MAX_VIEWER_BYTES) {
    throw new Error(`viewer exceeds 200kb for ${article.id}`);
  }
  return html;
}

export async function buildViewers(root: string, options: ViewerOptions): Promise<ViewerResult> {
  const ids = options.article === undefined ? await listPendingIds(root) : [options.article];
  const result: ViewerResult = { built: 0, skipped: 0, failed: 0 };
  for (const id of ids) {
    let article: PendingArticle;
    try {
      article = await loadPending(root, id);
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "viewer", { event: "load_failed", id, error: messageOf(error) });
      continue;
    }
    if (article.status !== "reviewed" && article.status !== "published") {
      result.skipped += 1;
      continue;
    }
    try {
      const html = await renderViewer(root, article, options.layout);
      await writeTextAtomic(join(root, "site", "viewers", `${slugify(article.title)}.html`), html);
      result.built += 1;
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "viewer", { event: "build_failed", id, error: messageOf(error) });
    }
  }
  return result;
}
