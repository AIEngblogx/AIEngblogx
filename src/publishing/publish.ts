import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "../shared/config.ts";
import { readGlossary } from "../shared/glossary.ts";
import { appendLog, messageOf } from "../shared/log.ts";
import {
  type ArticleIndex,
  listPendingIds,
  loadIndex,
  loadPending,
  type PendingArticle,
  saveIndex,
  savePending,
  slugify,
  writeTextAtomic,
} from "../shared/store.ts";
import { validateForPublish } from "../translation/review.ts";
import { sendNotification } from "./notify.ts";
import { escapeHtml, type PageLink, publishedPages, renderShell, SITE_TITLE } from "./site.ts";
import { buildViewers } from "./viewer.ts";

export interface PublishOptions {
  dryRun: boolean;
}

export interface PublishResult {
  published: number;
  skipped: number;
  failed: number;
}

function yamlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ");
  return `"${escaped}"`;
}

async function renderPost(root: string, article: PendingArticle, tags: string[]): Promise<string> {
  const glossary = await readGlossary(root);
  const lines = [
    "---",
    `title: ${yamlString(article.title)}`,
    `original_title: ${yamlString(article.title)}`,
    `url: ${yamlString(article.url)}`,
    `date: ${article.published_at}`,
    `tags: [${tags.join(", ")}]`,
    "status: reviewed",
  ];
  const translator = process.env.BLOG_TRANSLATOR;
  const reviewer = process.env.BLOG_REVIEWER;
  if (translator !== undefined && translator !== "")
    lines.push(`translator: ${yamlString(translator)}`);
  if (reviewer !== undefined && reviewer !== "") lines.push(`reviewer: ${yamlString(reviewer)}`);
  lines.push("---", "");

  lines.push(`Original: [${article.url}](${article.url})`, "");
  const summary = article.raw_html_excerpt || article.source_paragraphs[0] || article.title;
  lines.push("## Summary", "", summary.replace(/<[^>]+>/g, " ").trim(), "");
  lines.push("## Translation", "", article.target_paragraphs.join("\n\n"), "");
  const images = article.images ?? [];
  if (images.length > 0) {
    lines.push("## Figures", "");
    for (const image of images) {
      const alt = image.alt.replace(/[\r\n[\]]/g, " ").trim() || "Figures";
      const url = image.url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
      lines.push(`![${alt}](${url})`, "");
    }
  }
  lines.push(
    "## Translator notes",
    "",
    article.human_notes === "" ? "None" : article.human_notes,
    "",
  );
  lines.push("## Glossary", "", "| Term | Rule |", "|---|---|");
  for (const [term, rule] of Object.entries(glossary)) {
    lines.push(`| ${term} | ${JSON.stringify(rule)} |`);
  }
  lines.push("", "## Disclaimer", "");
  lines.push(`Translations are provided as-is. Original: [${article.url}](${article.url})。`, "");
  return lines.join("\n");
}

function renderIndex(index: ArticleIndex): string {
  const published = index.articles
    .filter((article) => article.status === "published")
    .sort((left, right) => right.published_at.localeCompare(left.published_at));
  const lines = [
    "# Blog Translations",
    "",
    "Side-by-side translations of public engineering articles.",
    "",
    "## Articles",
    "",
  ];
  if (published.length === 0) {
    lines.push("No published articles yet.", "");
  } else {
    for (const article of published) {
      const slug = slugify(article.title);
      lines.push(
        `- [${article.title}](viewers/${slug}.html) · ${article.published_at} · ${article.source} · [Original](${article.url})`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## About",
    "",
    "- [Translation policy and workflow](about.md)",
    "- [RSS](rss.xml)",
    "",
  );
  return lines.join("\n");
}

function pageLinks(
  index: ArticleIndex,
  activeHref: string,
): { prev: PageLink | null; next: PageLink | null } {
  const pages = publishedPages(index);
  const position = pages.findIndex((page) => page.href === activeHref);
  const previous = pages[position - 1];
  const following = pages[position + 1];
  return {
    prev: previous === undefined ? null : { label: previous.label, href: previous.href },
    next:
      position < 0 || following === undefined
        ? null
        : { label: following.label, href: following.href },
  };
}

function renderIndexHtml(index: ArticleIndex): string {
  const pages = publishedPages(index);
  const lines = [
    "<p>Side-by-side translations of public engineering articles. Every article links to the original and is published only after human review.</p>",
  ];
  if (pages.length === 0) {
    lines.push("<p>No published articles yet.</p>");
  } else {
    lines.push('<ul class="post-list">');
    for (const page of pages) {
      lines.push(
        `<li><a href="${page.href}">${escapeHtml(page.label)}</a>` +
          `<span class="date">${escapeHtml(page.date)}</span></li>`,
      );
    }
    lines.push("</ul>");
  }
  lines.push('<p><a href="about.html">About</a> · <a href="rss.xml">RSS</a></p>');
  return renderShell({
    title: "Contents",
    heading: SITE_TITLE,
    subline: "Side-by-side translations of public engineering articles",
    prefix: "",
    activeHref: "index.html",
    index,
    content: lines.join("\n"),
  });
}

async function renderPostHtml(
  root: string,
  article: PendingArticle,
  index: ArticleIndex,
): Promise<string> {
  const glossary = await readGlossary(root);
  const slug = slugify(article.title);
  const activeHref = `viewers/${slug}.html`;
  const lines: string[] = [];
  const summary = article.raw_html_excerpt || article.source_paragraphs[0] || article.title;
  lines.push("<h2>Summary</h2>", `<p>${escapeHtml(summary.replace(/<[^>]+>/g, " ").trim())}</p>`);
  lines.push("<h2>Translation</h2>");
  for (const paragraph of article.target_paragraphs) {
    lines.push(`<p>${escapeHtml(paragraph)}</p>`);
  }
  const images = article.images ?? [];
  if (images.length > 0) {
    lines.push("<h2>Figures</h2>");
    for (const image of images) {
      lines.push(
        `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" loading="lazy">`,
      );
    }
  }
  lines.push("<h2>Translator notes</h2>", `<p>${escapeHtml(article.human_notes || "None")}</p>`);
  lines.push("<h2>Glossary</h2>");
  const entries = Object.entries(glossary);
  if (entries.length === 0) {
    lines.push("<p>None</p>");
  } else {
    lines.push("<table><thead><tr><th>Term</th><th>Rule</th></tr></thead><tbody>");
    for (const [term, rule] of entries) {
      lines.push(
        `<tr><td>${escapeHtml(term)}</td><td>${escapeHtml(JSON.stringify(rule))}</td></tr>`,
      );
    }
    lines.push("</tbody></table>");
  }
  lines.push(
    "<h2>Disclaimer</h2>",
    `<p>Translations are provided as-is. Original: <a href="${escapeHtml(article.url)}">` +
      `${escapeHtml(article.url)}</a>。</p>`,
    `<p><a href="../viewers/${slug}.html">Open the side-by-side reader</a></p>`,
  );
  const { prev, next } = pageLinks(index, activeHref);
  return renderShell({
    title: article.title,
    heading: article.title,
    subline:
      `Original: <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">` +
      `${escapeHtml(article.url)}</a> · ${escapeHtml(article.published_at)} · ` +
      `${escapeHtml(article.source)} · <a href="../viewers/${slug}.html">Side-by-side</a>`,
    prefix: "../",
    activeHref,
    index,
    content: lines.join("\n"),
    prev,
    next,
    language: article.target_language || "en",
  });
}

function renderAboutHtml(index: ArticleIndex): string {
  const lines = [
    "<p>This site publishes sentence-aligned translations of public engineering articles. Translations are provided as-is; every article links to the original. Only public text is collected, and robots.txt plus request throttling are respected.</p>",
    "<h2>Workflow</h2>",
    "<p>crawl → translate → align → review → build-viewer → publish</p>",
    "<p>Crawling and translation are repeatable; human review is mandatory before publishing.</p>",
    "<h2>Removal</h2>",
    "<p>Run <code>blog-translate publish --remove &lt;id&gt;</code> to remove an article, its page, and its reader.</p>",
  ];
  return renderShell({
    title: "About",
    heading: "About",
    subline: "Translation policy and workflow",
    prefix: "",
    activeHref: "about.html",
    index,
    content: lines.join("\n"),
  });
}

async function rebuildSite(root: string, index: ArticleIndex): Promise<void> {
  await writeTextAtomic(join(root, "site", "index.html"), renderIndexHtml(index));
  await writeTextAtomic(join(root, "site", "about.html"), renderAboutHtml(index));
  for (const page of publishedPages(index)) {
    let article: PendingArticle;
    try {
      article = await loadPending(root, page.id);
    } catch (error) {
      await appendLog(root, "publish", {
        event: "site_rebuild_skipped",
        id: page.id,
        error: messageOf(error),
      });
      continue;
    }
    await writeTextAtomic(
      join(root, "site", "posts", `${slugify(article.title)}.html`),
      await renderPostHtml(root, article, index),
    );
  }
  await buildViewers(root, { layout: "source-target" });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRss(index: ArticleIndex, siteUrl: string | null): string {
  const published = index.articles
    .filter((article) => article.status === "published")
    .sort((left, right) => right.published_at.localeCompare(left.published_at));
  const channelLink = siteUrl ?? "index.html";
  const items = published.map((article) => {
    const link = siteUrl
      ? `${siteUrl.replace(/\/$/, "")}/viewers/${slugify(article.title)}.html`
      : article.url;
    return [
      "    <item>",
      `      <title>${xmlEscape(article.title)}</title>`,
      `      <link>${xmlEscape(link)}</link>`,
      `      <guid isPermaLink="false">${article.id}</guid>`,
      `      <pubDate>${article.published_at}</pubDate>`,
      `      <description>${xmlEscape(article.source)}</description>`,
      "    </item>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    "    <title>Blog Translations</title>",
    `    <link>${xmlEscape(channelLink)}</link>`,
    "    <description>Translated engineering articles</description>",
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

async function ensureAbout(root: string): Promise<void> {
  const path = join(root, "site", "about.md");
  try {
    await readFile(path, "utf8");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = [
    "# About",
    "",
    "This site publishes sentence-aligned translations of public engineering articles. Translations are provided as-is;",
    "every article links to the original. Only public text is collected, and robots.txt plus request throttling are respected.",
    "",
    "## Workflow",
    "",
    "```",
    "crawl → translate → align → review → build-viewer → publish",
    "```",
    "",
    "Crawling and translation are repeatable; human review is mandatory before publishing.",
    "Translation uses an OpenAI-compatible endpoint; terminology rules live in `config/glossary.json`.",
    "",
    "## Glossary",
    "",
    "Terminology is defined per target language in the glossary;",
    "terms marked keep_original stay in the source language.",
    "",
    "## Removal",
    "",
    "Run `blog-translate publish --remove <id>` to remove an article, its Markdown, and its reader.",
    "",
  ];
  await writeTextAtomic(path, lines.join("\n"));
}

export async function publishAll(root: string, options: PublishOptions): Promise<PublishResult> {
  const config = await readConfig(root);
  const ids = await listPendingIds(root);
  const index = await loadIndex(root);
  const result: PublishResult = { published: 0, skipped: 0, failed: 0 };

  for (const id of ids) {
    let article: PendingArticle;
    try {
      article = await loadPending(root, id);
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "publish", { event: "load_failed", id, error: messageOf(error) });
      continue;
    }
    if (article.status === "published") {
      result.skipped += 1;
      continue;
    }
    const missing = validateForPublish(article);
    if (missing.length > 0) {
      result.failed += 1;
      await appendLog(root, "publish", { event: "validation_failed", id, missing });
      continue;
    }
    if (options.dryRun) {
      result.published += 1;
      continue;
    }

    const slug = slugify(article.title);
    const record = index.articles.find((item) => item.id === id);
    try {
      await writeTextAtomic(
        join(root, "site", "posts", `${slug}.md`),
        await renderPost(root, article, record?.tags ?? []),
      );
      const viewers = await buildViewers(root, { article: id, layout: "source-target" });
      if (viewers.built !== 1) throw new Error(`viewer not built for ${id}`);
      article.status = "published";
      if (record !== undefined) {
        record.status = "published";
        record.published_at_local = new Date().toISOString();
      }
      await savePending(root, article);
      result.published += 1;
      await sendNotification(root, {
        title: article.title,
        url: config.publish.site_url
          ? `${config.publish.site_url}/viewers/${slug}.html`
          : `viewers/${slug}.html`,
        original_url: article.url,
        date: article.published_at,
      });
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "publish", { event: "publish_failed", id, error: messageOf(error) });
    }
  }

  if (result.published > 0 && !options.dryRun) {
    await saveIndex(root, index);
    await writeTextAtomic(join(root, "site", "index.md"), renderIndex(index));
    await writeTextAtomic(join(root, "site", "rss.xml"), renderRss(index, config.publish.site_url));
    await ensureAbout(root);
    await rebuildSite(root, index);
  }
  return result;
}

export async function removeArticle(root: string, id: string): Promise<{ id: string }> {
  const article = await loadPending(root, id);
  const index = await loadIndex(root);
  const slug = slugify(article.title);
  await rm(join(root, "site", "posts", `${slug}.md`), { force: true });
  await rm(join(root, "site", "posts", `${slug}.html`), { force: true });
  await rm(join(root, "site", "viewers", `${slug}.html`), { force: true });
  article.status = "removed";
  const record = index.articles.find((item) => item.id === id);
  if (record !== undefined) record.status = "removed";
  await savePending(root, article);
  await saveIndex(root, index);
  await writeTextAtomic(join(root, "site", "index.md"), renderIndex(index));
  const config = await readConfig(root);
  await writeTextAtomic(join(root, "site", "rss.xml"), renderRss(index, config.publish.site_url));
  await rebuildSite(root, index);
  await appendLog(root, "publish", { event: "removed", id, slug });
  return { id };
}
