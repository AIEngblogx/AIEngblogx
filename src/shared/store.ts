import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ArticleStatus =
  | "pending"
  | "translated"
  | "aligned"
  | "reviewed"
  | "published"
  | "removed";

export interface ArticleRecord {
  id: string;
  source: string;
  url: string;
  title: string;
  target_title?: string;
  published_at: string;
  tags: string[];
  status: ArticleStatus;
  created_at: string;
  published_at_local: string | null;
}

export interface ArticleIndex {
  schema_version: 2;
  last_crawled_at: string | null;
  articles: ArticleRecord[];
}

export interface TranslationMeta {
  model: string;
  quant: string;
  language: string;
  elapsed_ms: number;
  tokens: number;
}

export interface Segment {
  index: number;
  source: string;
  target: string;
  confidence: number;
}

export interface ArticleImage {
  url: string;
  alt: string;
  before_paragraph: number;
}

export interface PendingArticle {
  id: string;
  source: string;
  url: string;
  title: string;
  published_at: string;
  raw_html_excerpt: string;
  images: ArticleImage[];
  source_paragraphs: string[];
  target_paragraphs: string[];
  target_language: string;
  segments: Segment[];
  human_edited: boolean;
  human_notes: string;
  translation_meta: TranslationMeta | null;
  status: ArticleStatus;
}

const INDEX_FILE = "data/articles.json";
const PENDING_DIR = "inbox/pending";

export function normalizeUrl(raw: string, base?: string): string {
  const url = base === undefined ? new URL(raw) : new URL(raw, base);
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

export function articleId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function emptyIndex(): ArticleIndex {
  return { schema_version: 2, last_crawled_at: null, articles: [] };
}

export async function loadIndex(root: string): Promise<ArticleIndex> {
  const path = join(root, INDEX_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid json in ${path}`);
  }
  const schemaVersion = (parsed as { schema_version?: unknown }).schema_version;
  if (schemaVersion === 1) {
    throw new Error(`index schema 1 in ${path} requires migration to 2`);
  }
  if (schemaVersion !== 2 || !Array.isArray((parsed as { articles?: unknown }).articles)) {
    throw new Error(`unsupported index schema in ${path}`);
  }
  return parsed as ArticleIndex;
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function saveIndex(root: string, index: ArticleIndex): Promise<void> {
  await writeJsonAtomic(join(root, INDEX_FILE), index);
}

export function pendingPath(root: string, id: string): string {
  return join(root, PENDING_DIR, `${id}.json`);
}

export async function savePending(root: string, article: PendingArticle): Promise<void> {
  await writeJsonAtomic(pendingPath(root, article.id), article);
}

export async function loadPending(root: string, id: string): Promise<PendingArticle> {
  const path = pendingPath(root, id);
  const parsed = JSON.parse(await readFile(path, "utf8")) as PendingArticle;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.url !== "string" ||
    !Array.isArray(parsed.source_paragraphs) ||
    !Array.isArray(parsed.segments)
  ) {
    throw new Error(`invalid pending article in ${path}`);
  }
  if (!Array.isArray(parsed.images)) parsed.images = [];
  if (!Array.isArray(parsed.target_paragraphs)) parsed.target_paragraphs = [];
  if (typeof parsed.target_language !== "string") parsed.target_language = "";
  return parsed;
}

export async function listPendingIds(root: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(join(root, PENDING_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .sort();
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug === "" ? "article" : slug;
}
