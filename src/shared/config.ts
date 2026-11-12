import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

export class ConfigError extends Error {}

export interface SourceConfig {
  name: string;
  list_url: string;
  extra_urls: string[];
}

export interface AppConfig {
  sources: SourceConfig[];
  crawl: {
    respect_robots: boolean;
    fetch_full_text: boolean;
    request_delay_ms: number;
    max_articles_per_source: number;
  };
  translate: {
    target_languages: string[];
    temperature: number;
  };
  align: {
    threshold: number;
  };
  publish: {
    site_url: string | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function readConfig(root: string): Promise<AppConfig> {
  const path = join(root, "config.toml");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let doc: Record<string, unknown>;
  try {
    doc = asRecord(parse(text));
  } catch (error) {
    throw new ConfigError(
      `invalid toml in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rawSources = doc.sources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new ConfigError(`missing sources in ${path}`);
  }
  const sources: SourceConfig[] = [];
  for (const raw of rawSources) {
    const item = asRecord(raw);
    if (
      typeof item.name !== "string" ||
      item.name === "" ||
      typeof item.list_url !== "string" ||
      item.list_url === ""
    ) {
      throw new ConfigError(`invalid source entry in ${path}`);
    }
    const extraUrls = Array.isArray(item.extra_urls)
      ? item.extra_urls.filter(
          (value): value is string => typeof value === "string" && value !== "",
        )
      : [];
    sources.push({ name: item.name, list_url: item.list_url, extra_urls: extraUrls });
  }

  const crawl = asRecord(doc.crawl);
  const translate = asRecord(doc.translate);
  const align = asRecord(doc.align);
  const publish = asRecord(doc.publish);
  const languages = Array.isArray(translate.target_languages)
    ? translate.target_languages.filter(
        (value): value is string => typeof value === "string" && value !== "",
      )
    : [];
  return {
    sources,
    crawl: {
      respect_robots: flag(crawl.respect_robots, true),
      fetch_full_text: flag(crawl.fetch_full_text, true),
      request_delay_ms: number(crawl.request_delay_ms, 1000),
      max_articles_per_source: number(crawl.max_articles_per_source, 20),
    },
    translate: {
      target_languages: languages.length > 0 ? languages : ["zh-CN"],
      temperature: number(translate.temperature, 0.2),
    },
    align: { threshold: number(align.threshold, 0.6) },
    publish: {
      site_url:
        typeof publish.site_url === "string" && publish.site_url !== "" ? publish.site_url : null,
    },
  };
}
