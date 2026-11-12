import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CrawlError, type CrawlOptions, crawlOnce } from "../src/crawler/crawl.ts";
import { dateOnly } from "../src/crawler/parse.ts";
import {
  type ArticleIndex,
  articleId,
  loadIndex,
  normalizeUrl,
  type PendingArticle,
  pendingPath,
} from "../src/shared/store.ts";

function fixture(name: string): string {
  return fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
}

let server: Server;
let baseUrl = "";
let html = "";
let sitemap = "";
let articleHtml = "";
let cardsHtml = "";
let feed = "";
let robots = "User-agent: *\nAllow: /\n";
let listFailures = 0;
let listRequests = 0;

function titleFrom(path: string): string {
  const slug =
    path
      .split("/")
      .filter((part) => part !== "")
      .pop() ?? "";
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

before(async () => {
  html = await readFile(fixture("engineering.html"), "utf8");
  sitemap = await readFile(fixture("sitemap.xml"), "utf8");
  articleHtml = await readFile(fixture("article.html"), "utf8");
  cardsHtml = await readFile(fixture("cards.html"), "utf8");
  feed = await readFile(fixture("feed.xml"), "utf8");
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(robots);
      return;
    }
    if (path === "/feed") {
      response.writeHead(200, { "content-type": "application/rss+xml" });
      response.end(feed.replaceAll("https://source.test", baseUrl));
      return;
    }
    if (path === "/sitemap.xml") {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(sitemap.replaceAll("https://source.test", baseUrl));
      return;
    }
    if (path === "/engineering" || path === "/engineering-alt") {
      listRequests += 1;
      if (listFailures > 0) {
        listFailures -= 1;
        response.writeHead(503);
        response.end("");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(path === "/engineering-alt" ? cardsHtml : html);
      return;
    }
    if (path.startsWith("/engineering/")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(articleHtml.replaceAll("TEST_ARTICLE_TITLE", titleFrom(path)));
      return;
    }
    response.writeHead(404);
    response.end("");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function configText(sources: { name: string; url: string }[]): string {
  const entries = sources
    .map((source) => `[[sources]]\nname = "${source.name}"\nlist_url = "${source.url}"\n`)
    .join("\n");
  return (
    `${entries}\n[crawl]\nrespect_robots = true\nfetch_full_text = true\nrequest_delay_ms = 0\n\n` +
    "[translate]\ntemperature = 0.2\n\n[align]\nthreshold = 0.6\n"
  );
}

async function makeRoot(sources?: { name: string; url: string }[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blog-translate-"));
  const list = sources ?? [{ name: "test-source", url: `${baseUrl}/engineering` }];
  await writeFile(join(root, "config.toml"), configText(list), "utf8");
  return root;
}

function run(root: string, overrides: Partial<Omit<CrawlOptions, "root">> = {}) {
  return crawlOnce({ root, dryRun: false, limit: null, backoffMs: [0, 0, 0], ...overrides });
}

test("new articles land in inbox with schema v2 and full text", async () => {
  const root = await makeRoot();
  try {
    const result = await run(root);
    assert.deepEqual(result, { new: 2, skipped: 0, failed: 0 });
    const index = await loadIndex(root);
    assert.equal(index.schema_version, 2);
    assert.equal(index.articles.length, 2);
    assert.notEqual(index.last_crawled_at, null);
    for (const article of index.articles) {
      assert.equal(article.status, "pending");
      assert.equal(article.source, "test-source");
      assert.equal(article.id, articleId(article.url));
      const pending = JSON.parse(
        await readFile(pendingPath(root, article.id), "utf8"),
      ) as PendingArticle;
      assert.equal(pending.status, "pending");
      assert.equal(pending.source, "test-source");
      assert.equal(pending.human_edited, false);
      assert.equal(pending.translation_meta, null);
      assert.ok(pending.source_paragraphs.length >= 3);
      assert.match(pending.source_paragraphs.join(" "), /Connection pooling/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second crawl adds nothing", async () => {
  const root = await makeRoot();
  try {
    assert.equal((await run(root)).new, 2);
    const before = await readdir(join(root, "inbox", "pending"));
    assert.deepEqual(await run(root), { new: 0, skipped: 2, failed: 0 });
    assert.equal((await loadIndex(root)).articles.length, 2);
    assert.deepEqual(await readdir(join(root, "inbox", "pending")), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--source and --url select one source explicitly", async () => {
  const root = await makeRoot([
    { name: "primary", url: `${baseUrl}/engineering` },
    { name: "secondary", url: `${baseUrl}/engineering-alt` },
  ]);
  const single = await makeRoot();
  try {
    assert.equal((await run(root)).new, 4);
    assert.deepEqual(await run(root, { source: "primary" }), {
      new: 0,
      skipped: 2,
      failed: 0,
    });
    await assert.rejects(run(single, { url: baseUrl }), /--url requires --source/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(single, { recursive: true, force: true });
  }
});

test("--dry-run leaves index and inbox untouched", async () => {
  const root = await makeRoot();
  try {
    assert.equal((await run(root, { dryRun: true })).new, 2);
    assert.equal((await loadIndex(root)).articles.length, 0);
    await assert.rejects(readdir(join(root, "inbox", "pending")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--limit caps discovered articles", async () => {
  const root = await makeRoot();
  try {
    assert.equal((await run(root, { limit: 1 })).new, 1);
    assert.equal((await loadIndex(root)).articles.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero parsed articles exits 2 without overwriting the index", async () => {
  const root = await makeRoot();
  try {
    const existing: ArticleIndex = {
      schema_version: 2,
      last_crawled_at: "2024-05-14T00:00:00.000Z",
      articles: [],
    };
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "articles.json"), JSON.stringify(existing), "utf8");
    const previousHtml = html;
    const previousSitemap = sitemap;
    html = "<html><body><main>no cards</main></body></html>";
    sitemap = "<urlset></urlset>";
    try {
      await assert.rejects(run(root), (error: unknown) => {
        assert.ok(error instanceof CrawlError);
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /all sources failed/);
        return true;
      });
      assert.equal((await loadIndex(root)).last_crawled_at, existing.last_crawled_at);
    } finally {
      html = previousHtml;
      sitemap = previousSitemap;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient http failures are retried", async () => {
  const root = await makeRoot();
  try {
    listFailures = 2;
    const before = listRequests;
    assert.equal((await run(root)).new, 2);
    assert.equal(listRequests - before, 3);
  } finally {
    listFailures = 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("a disallowed listing is rejected", async () => {
  const root = await makeRoot();
  const previous = robots;
  robots = "User-agent: *\nDisallow: /engineering\n";
  try {
    await assert.rejects(run(root), (error: unknown) => {
      assert.ok(error instanceof CrawlError);
      assert.match(error.message, /robots.txt disallows/);
      return true;
    });
  } finally {
    robots = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("disallowed article pages fail without blocking others", async () => {
  const root = await makeRoot();
  const previous = robots;
  robots = "User-agent: *\nAllow: /\nDisallow: /engineering/http-caching-mistakes\n";
  try {
    assert.deepEqual(await run(root), { new: 1, skipped: 0, failed: 1 });
    const titles = (await loadIndex(root)).articles.map((article) => article.title);
    assert.ok(!titles.includes("A year of HTTP caching mistakes"));
  } finally {
    robots = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("RSS feed entries keep real titles and dates, off-site links are skipped", async () => {
  const root = await makeRoot([{ name: "feed-source", url: `${baseUrl}/feed` }]);
  try {
    assert.deepEqual(await run(root), { new: 2, skipped: 0, failed: 0 });
    const articles = (await loadIndex(root)).articles;
    assert.deepEqual(articles.map((article) => article.title).sort(), [
      "Query planner regressions after an upgrade",
      "Tracing a slow build",
    ]);
    assert.ok(articles.every((article) => /^\d{4}-\d{2}-\d{2}$/.test(article.published_at)));
    assert.equal(articles[0]?.source, "feed-source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured per-source cap applies unless --limit overrides it", async () => {
  const root = await makeRoot();
  const path = join(root, "config.toml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "request_delay_ms = 0",
      "request_delay_ms = 0\nmax_articles_per_source = 1",
    ),
    "utf8",
  );
  try {
    assert.equal((await run(root)).new, 1);
    assert.equal((await loadIndex(root)).articles.length, 1);
    assert.equal((await run(root, { limit: 2 })).new, 1);
    assert.equal((await loadIndex(root)).articles.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("card markup is parsed when json-ld is absent", async () => {
  const root = await makeRoot();
  const previous = html;
  html = cardsHtml;
  try {
    assert.equal((await run(root)).new, 2);
    const titles = (await loadIndex(root)).articles.map((article) => article.title).sort();
    assert.deepEqual(titles, [
      "Query planner regressions after an upgrade",
      "Tracing a slow build",
    ]);
  } finally {
    html = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("sitemap titles come from the article page, not the slug", async () => {
  const root = await makeRoot();
  const previousHtml = html;
  html = "<html><body></body></html>";
  try {
    assert.deepEqual(await run(root), { new: 2, skipped: 0, failed: 0 });
    const titles = (await loadIndex(root)).articles.map((article) => article.title).sort();
    assert.deepEqual(titles, ["Query Planner Regressions", "Tracing A Slow Build"]);
  } finally {
    html = previousHtml;
    await rm(root, { recursive: true, force: true });
  }
});

test("configured extra urls fill articles the listing does not render", async () => {
  const root = await makeRoot();
  const path = join(root, "config.toml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      `list_url = "${baseUrl}/engineering"`,
      `list_url = "${baseUrl}/engineering"\nextra_urls = ["${baseUrl}/engineering/extra-post", "${baseUrl}/engineering/extra-post"]`,
    ),
    "utf8",
  );
  try {
    assert.equal((await run(root)).new, 3);
    const articles = (await loadIndex(root)).articles;
    assert.equal(articles.length, 3);
    assert.ok(articles.some((article) => article.title === "Extra Post"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("article images keep absolute urls, alt text and positions", async () => {
  const root = await makeRoot();
  try {
    await run(root);
    const first = (await loadIndex(root)).articles[0];
    assert.ok(first !== undefined);
    const pending = JSON.parse(
      await readFile(pendingPath(root, first.id), "utf8"),
    ) as PendingArticle;
    assert.deepEqual(pending.images, [
      { url: `${baseUrl}/images/figure.png`, alt: "Connection pool diagram", before_paragraph: 1 },
      { url: `${baseUrl}/images/lazy.png`, alt: "Latency percentiles", before_paragraph: 2 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dateOnly keeps calendar dates without UTC drift", () => {
  assert.equal(dateOnly("Nov 6, 2024"), "2024-11-06");
  assert.equal(dateOnly("Wed, 11 Nov 2024 15:00:15 +0000"), "2024-11-11");
  assert.equal(dateOnly("2024-11-06T12:00:00Z"), "2024-11-06");
  assert.equal(dateOnly(""), null);
  assert.equal(dateOnly(42), null);
});

test("normalized urls produce stable sha256 ids", () => {
  const normalized = normalizeUrl("https://WWW.anthropic.com/engineering/foo/#section");
  assert.equal(normalized, "https://www.anthropic.com/engineering/foo");
  const id = articleId(normalized);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, articleId(normalizeUrl("https://www.anthropic.com/engineering/foo/#other")));
});

test("schema v1 index is rejected with a migration hint", async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(
      join(root, "data", "articles.json"),
      JSON.stringify({ schema_version: 1, last_crawled_at: null, articles: [] }),
      "utf8",
    );
    await assert.rejects(loadIndex(root), /requires migration to 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
