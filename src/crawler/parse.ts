import { load } from "cheerio";
import { messageOf } from "../shared/log.ts";
import { type ArticleImage, normalizeUrl } from "../shared/store.ts";

export interface DiscoveredArticle {
  url: string;
  title: string;
  publishedAt: string;
  summary: string;
  excerpt: string;
  origin: "jsonld" | "cards" | "feed" | "sitemap" | "config";
}

export interface ArticleBody {
  title: string;
  publishedAt: string;
  paragraphs: string[];
  images: ArticleImage[];
}

const MAX_IMAGES = 20;
const IMAGE_SRC_ATTRS = ["src", "data-src", "data-original", "data-lazy-src", "data-url"];

export function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (iso !== undefined) return iso;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const hasZone = /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i.test(text);
  if (hasZone) return parsed.toISOString().slice(0, 10);
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

export function splitSummary(summary: string): string[] {
  return summary
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function collectJsonLd(value: unknown, baseUrl: string, found: DiscoveredArticle[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLd(item, baseUrl, found);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const isArticle =
    (typeof type === "string" && /^(Article|BlogPosting|NewsArticle|TechArticle)$/.test(type)) ||
    (Array.isArray(type) && type.includes("BlogPosting"));
  if (isArticle && typeof record.url === "string") {
    const summary = typeof record.description === "string" ? record.description.trim() : "";
    found.push({
      url: normalizeUrl(record.url, baseUrl),
      title: typeof record.headline === "string" ? record.headline.trim() : "",
      publishedAt: dateOnly(record.datePublished) ?? "",
      summary,
      excerpt: summary,
      origin: "jsonld",
    });
  }

  for (const key of ["@graph", "itemListElement", "mainEntity", "item", "blogPost"]) {
    const child = record[key];
    if (child !== undefined) collectJsonLd(child, baseUrl, found);
  }
}

export function parseJsonLd(
  html: string,
  baseUrl: string,
  warnings: string[],
): DiscoveredArticle[] {
  const $ = load(html);
  const found: DiscoveredArticle[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    let value: unknown;
    try {
      value = JSON.parse($(element).text());
    } catch (error) {
      warnings.push(`invalid json-ld block in ${baseUrl}: ${messageOf(error)}`);
      return;
    }
    collectJsonLd(value, baseUrl, found);
  });
  return found;
}

export function parseCards(html: string, baseUrl: string): DiscoveredArticle[] {
  const $ = load(html);
  const found: DiscoveredArticle[] = [];
  const seen = new Set<string>();
  for (const selector of ["article", "[data-post-card]", ".post-card"]) {
    $(selector).each((_, element) => {
      const anchor = $(element).is("a") ? $(element) : $(element).find("a[href]").first();
      const href = anchor.attr("href");
      if (href === undefined) return;
      const title = $(element).find("h1, h2, h3").first().text().trim() || anchor.text().trim();
      if (title === "") return;
      const time = $(element).find("time").first();
      const summary = $(element).find("p").first().text().trim();
      const url = normalizeUrl(href, baseUrl);
      if (seen.has(url)) return;
      seen.add(url);
      found.push({
        url,
        title,
        publishedAt: dateOnly(time.attr("datetime") ?? time.text()) ?? "",
        summary,
        excerpt: $.html(element) ?? "",
        origin: "cards",
      });
    });
    if (found.length > 0) break;
  }
  return found;
}

export function parseSitemap(
  xml: string,
  baseUrl: string,
  warnings: string[],
): DiscoveredArticle[] {
  const $ = load(xml, { xmlMode: true });
  const listing = new URL(baseUrl);
  const prefix = listing.pathname.replace(/\/$/, "");
  const found: DiscoveredArticle[] = [];
  $("url").each((_, element) => {
    const loc = $(element).find("loc").first().text().trim();
    if (loc === "") return;
    let url: URL;
    try {
      url = new URL(loc);
    } catch (error) {
      warnings.push(`invalid sitemap loc ${loc}: ${messageOf(error)}`);
      return;
    }
    if (url.origin !== listing.origin || !url.pathname.startsWith(`${prefix}/`)) return;
    found.push({
      url: normalizeUrl(url.toString()),
      title: "",
      publishedAt: dateOnly($(element).find("lastmod").first().text()) ?? "",
      summary: "",
      excerpt: "",
      origin: "sitemap",
    });
  });
  return found;
}

export function parseFeed(xml: string, baseUrl: string, warnings: string[]): DiscoveredArticle[] {
  const $ = load(xml, { xmlMode: true });
  const listingOrigin = new URL(baseUrl).origin;
  const found: DiscoveredArticle[] = [];
  const seen = new Set<string>();
  $("item, entry").each((_, element) => {
    const node = $(element);
    const link = node.find("link").first();
    const href = link.attr("href") ?? link.text().trim();
    if (href === "") return;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch (error) {
      warnings.push(`invalid feed link ${href}: ${messageOf(error)}`);
      return;
    }
    if (url.origin !== listingOrigin) return;
    const normalized = normalizeUrl(url.toString());
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const summary = node.find("description, summary").first().text().trim();
    found.push({
      url: normalized,
      title: node.find("title").first().text().trim(),
      publishedAt: dateOnly(node.find("pubDate, published, updated").first().text()) ?? "",
      summary,
      excerpt: summary,
      origin: "feed",
    });
  });
  return found;
}

export function parseArticlePage(html: string, baseUrl?: string): ArticleBody {
  const $ = load(html);
  const title =
    $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content")?.trim() || "";
  const publishedAt =
    dateOnly($('meta[property="article:published_time"]').attr("content")) ??
    dateOnly($("time[datetime]").first().attr("datetime")) ??
    "";
  const scope = $("article").first().length > 0 ? $("article").first() : $("main").first();
  const root = scope.length > 0 ? scope : $("body");
  const paragraphs: string[] = [];
  const images: ArticleImage[] = [];
  const seenImages = new Set<string>();
  root.find("p, li, pre, h2, h3, img").each((_, element) => {
    const node = $(element);
    if (node.is("img")) {
      if (images.length >= MAX_IMAGES) return;
      let raw = "";
      for (const attribute of IMAGE_SRC_ATTRS) {
        const value = node.attr(attribute);
        if (value !== undefined && value.trim() !== "") {
          raw = value.trim();
          break;
        }
      }
      if (raw === "") {
        const srcset = node.attr("srcset") ?? node.attr("data-srcset") ?? "";
        raw = srcset.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
      }
      if (raw === "" || raw.startsWith("data:")) return;
      let resolved: URL;
      try {
        resolved = new URL(raw, baseUrl);
      } catch {
        return;
      }
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
      const url = resolved.toString();
      if (seenImages.has(url)) return;
      seenImages.add(url);
      const alt =
        node.attr("alt")?.trim() ||
        node.closest("figure").find("figcaption").first().text().replace(/\s+/g, " ").trim() ||
        "";
      images.push({ url, alt, before_paragraph: paragraphs.length });
      return;
    }
    const text = node.text().replace(/\s+/g, " ").trim();
    if (text !== "") paragraphs.push(text);
  });
  return { title, publishedAt, paragraphs, images };
}
