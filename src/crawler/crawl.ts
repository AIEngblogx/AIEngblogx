import { setTimeout as sleep } from "node:timers/promises";
import { type AppConfig, readConfig, type SourceConfig } from "../shared/config.ts";
import { appendLog, messageOf } from "../shared/log.ts";
import {
  type ArticleImage,
  type ArticleRecord,
  articleId,
  loadIndex,
  normalizeUrl,
  type PendingArticle,
  saveIndex,
  savePending,
} from "../shared/store.ts";
import {
  type DiscoveredArticle,
  parseArticlePage,
  parseCards,
  parseFeed,
  parseJsonLd,
  parseSitemap,
  splitSummary,
} from "./parse.ts";

export class CrawlError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface CrawlOptions {
  root: string;
  source?: string;
  url?: string;
  dryRun: boolean;
  limit: number | null;
  backoffMs?: readonly number[];
}

export interface CrawlResult {
  new: number;
  skipped: number;
  failed: number;
}

const DEFAULT_BACKOFF = [1000, 4000, 16000] as const;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xml,text/xml,text/plain",
    },
  });
  if (!response.ok) throw new Error(`http ${response.status} for ${url}`);
  return response.text();
}

async function fetchWithRetry(
  url: string,
  backoff: readonly number[],
  root: string,
): Promise<string> {
  let lastMessage = "";
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return await fetchText(url, FETCH_TIMEOUT_MS);
    } catch (error) {
      lastMessage = messageOf(error);
      await appendLog(root, "crawl", {
        event: "fetch_retry",
        url,
        attempt: attempt + 1,
        error: lastMessage,
      });
      const delay = backoff[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw new CrawlError(
    `fetch failed after ${backoff.length + 1} attempts for ${url}: ${lastMessage}`,
  );
}

function isAllowed(robots: string, path: string): boolean {
  let applies = false;
  let verdict = true;
  let matchedLength = -1;
  for (const line of robots.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value =
      line
        .slice(colon + 1)
        .split("#")[0]
        ?.trim() ?? "";
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("blog-translate");
      continue;
    }
    if (!applies || value === "") continue;
    const prefix = value.split("*")[0] ?? "";
    if (prefix === "" || !path.startsWith(prefix) || prefix.length <= matchedLength) continue;
    matchedLength = prefix.length;
    if (key === "disallow") verdict = false;
    else if (key === "allow") verdict = true;
  }
  return verdict;
}

async function assertRobotsAllows(
  root: string,
  target: string,
  cache: Map<string, string>,
): Promise<void> {
  const url = new URL(target);
  let robots = cache.get(url.origin);
  if (robots === undefined) {
    const robotsUrl = new URL("/robots.txt", url.origin).toString();
    try {
      robots = await fetchText(robotsUrl, FETCH_TIMEOUT_MS);
    } catch (error) {
      await appendLog(root, "crawl", {
        event: "robots_unavailable",
        url: robotsUrl,
        error: messageOf(error),
      });
      robots = "";
    }
    cache.set(url.origin, robots);
  }
  if (robots !== "" && !isAllowed(robots, url.pathname)) {
    throw new CrawlError(`robots.txt disallows ${target}`);
  }
}

async function discover(root: string, listUrl: string, html: string): Promise<DiscoveredArticle[]> {
  const warnings: string[] = [];
  if (/^\s*<\?xml[^>]*\?>\s*<(rss|feed)\b/i.test(html)) {
    const feed = parseFeed(html, listUrl, warnings);
    await flushWarnings(root, listUrl, warnings);
    return feed;
  }
  const jsonLd = parseJsonLd(html, listUrl, warnings);
  if (jsonLd.length > 0) {
    await flushWarnings(root, listUrl, warnings);
    return jsonLd;
  }

  const cards = parseCards(html, listUrl);
  if (cards.length > 0) {
    await flushWarnings(root, listUrl, warnings);
    return cards;
  }

  let sitemap: DiscoveredArticle[] = [];
  try {
    const xml = await fetchText(new URL("/sitemap.xml", listUrl).toString(), FETCH_TIMEOUT_MS);
    sitemap = parseSitemap(xml, listUrl, warnings);
  } catch (error) {
    warnings.push(`sitemap unavailable: ${messageOf(error)}`);
  }
  await flushWarnings(root, listUrl, warnings);
  return sitemap;
}

async function flushWarnings(root: string, url: string, warnings: string[]): Promise<void> {
  if (warnings.length > 0) {
    await appendLog(root, "crawl", { event: "parse_warning", url, warnings });
  }
}

async function crawlSource(
  root: string,
  target: SourceConfig,
  options: CrawlOptions,
  config: AppConfig,
): Promise<CrawlResult> {
  let listUrl: string;
  try {
    listUrl = normalizeUrl(options.url ?? target.list_url);
  } catch (error) {
    await appendLog(root, "crawl", { event: "invalid_list_url", error: messageOf(error) });
    throw new CrawlError(`invalid list_url for source ${target.name}`);
  }

  const robotsCache = new Map<string, string>();
  if (config.crawl.respect_robots) await assertRobotsAllows(root, listUrl, robotsCache);
  const html = await fetchWithRetry(listUrl, options.backoffMs ?? DEFAULT_BACKOFF, root);
  const discovered = await discover(root, listUrl, html);
  for (const raw of target.extra_urls) {
    let extraUrl: string;
    try {
      extraUrl = normalizeUrl(raw, listUrl);
    } catch (error) {
      await appendLog(root, "crawl", {
        event: "invalid_extra_url",
        url: raw,
        error: messageOf(error),
      });
      continue;
    }
    if (discovered.some((entry) => entry.url === extraUrl)) continue;
    discovered.push({
      url: extraUrl,
      title: "",
      publishedAt: "",
      summary: "",
      excerpt: "",
      origin: "config",
    });
  }
  if (discovered.length === 0) {
    await appendLog(root, "crawl", { event: "parse_empty", url: listUrl, source: target.name });
    throw new CrawlError(`no articles parsed from ${listUrl}`);
  }

  const index = await loadIndex(root);
  const known = new Set(index.articles.map((article) => article.id));
  const result: CrawlResult = { new: 0, skipped: 0, failed: 0 };
  const cap = options.limit ?? config.crawl.max_articles_per_source;
  const batch = cap > 0 ? discovered.slice(0, cap) : discovered;
  const timestamp = new Date().toISOString();

  for (const entry of batch) {
    const id = articleId(entry.url);
    if (known.has(id)) {
      result.skipped += 1;
      continue;
    }

    if (config.crawl.respect_robots) {
      try {
        await assertRobotsAllows(root, entry.url, robotsCache);
      } catch (error) {
        result.failed += 1;
        await appendLog(root, "crawl", {
          event: "article_robots_disallowed",
          url: entry.url,
          source: target.name,
          error: messageOf(error),
        });
        continue;
      }
    }

    let title = entry.title;
    let publishedAt = entry.publishedAt;
    let paragraphs = splitSummary(entry.summary);
    let images: ArticleImage[] = [];
    if (config.crawl.fetch_full_text || entry.origin === "sitemap") {
      if (config.crawl.request_delay_ms > 0) await sleep(config.crawl.request_delay_ms);
      try {
        const body = parseArticlePage(await fetchText(entry.url, FETCH_TIMEOUT_MS), entry.url);
        if (title === "") title = body.title;
        if (publishedAt === "") publishedAt = body.publishedAt;
        if (body.paragraphs.length > 0) paragraphs = body.paragraphs;
        images = body.images;
      } catch (error) {
        result.failed += 1;
        await appendLog(root, "crawl", {
          event: "article_page_failed",
          url: entry.url,
          source: target.name,
          error: messageOf(error),
        });
        continue;
      }
    }

    if (title === "" || publishedAt === "" || paragraphs.length === 0) {
      result.failed += 1;
      await appendLog(root, "crawl", {
        event: "incomplete_metadata",
        url: entry.url,
        source: target.name,
      });
      continue;
    }

    const record: ArticleRecord = {
      id,
      source: target.name,
      url: entry.url,
      title,
      published_at: publishedAt,
      tags: [],
      status: "pending",
      created_at: timestamp,
      published_at_local: null,
    };
    const pending: PendingArticle = {
      id,
      source: target.name,
      url: entry.url,
      title,
      published_at: publishedAt,
      raw_html_excerpt: entry.excerpt,
      images,
      source_paragraphs: paragraphs,
      target_paragraphs: [],
      target_language: "",
      segments: [],
      human_edited: false,
      human_notes: "",
      translation_meta: null,
      status: "pending",
    };

    try {
      if (!options.dryRun) {
        await savePending(root, pending);
        index.articles.push(record);
      }
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "crawl", {
        event: "article_write_failed",
        url: entry.url,
        error: messageOf(error),
      });
      continue;
    }

    known.add(id);
    result.new += 1;
    await appendLog(root, "crawl", {
      event: "article_discovered",
      id,
      url: entry.url,
      source: target.name,
      origin: entry.origin,
      dry_run: options.dryRun,
    });
  }

  if (!options.dryRun) {
    index.last_crawled_at = timestamp;
    await saveIndex(root, index);
  }
  await appendLog(root, "crawl", {
    event: "source_finished",
    source: target.name,
    url: listUrl,
    ...result,
  });
  return result;
}

export async function crawlOnce(options: CrawlOptions): Promise<CrawlResult> {
  const { root } = options;
  if (options.url !== undefined && options.source === undefined) {
    throw new CrawlError("--url requires --source");
  }
  const config = await readConfig(root);
  const targets = config.sources.filter(
    (item) => options.source === undefined || item.name === options.source,
  );
  if (targets.length === 0) {
    throw new CrawlError(`unknown source "${options.source}"`);
  }

  const result: CrawlResult = { new: 0, skipped: 0, failed: 0 };
  const errors: string[] = [];
  for (const target of targets) {
    try {
      const one = await crawlSource(root, target, options, config);
      result.new += one.new;
      result.skipped += one.skipped;
      result.failed += one.failed;
    } catch (error) {
      result.failed += 1;
      errors.push(messageOf(error));
      await appendLog(root, "crawl", {
        event: "source_failed",
        source: target.name,
        error: messageOf(error),
      });
    }
  }

  if (result.new === 0 && result.skipped === 0 && errors.length === targets.length) {
    throw new CrawlError(`all sources failed: ${errors.join("; ")}`);
  }
  return result;
}
