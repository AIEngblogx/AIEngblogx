import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishAll, removeArticle } from "../src/publishing/publish.ts";
import {
  type ArticleIndex,
  loadIndex,
  loadPending,
  type PendingArticle,
  type Segment,
  saveIndex,
  savePending,
} from "../src/shared/store.ts";
import { listForReview, validateForPublish } from "../src/translation/review.ts";

const CONFIG =
  '[[sources]]\nname = "test"\nlist_url = "https://example.test"\n\n' +
  "[crawl]\nrespect_robots = true\nfetch_full_text = true\nrequest_delay_ms = 0\n\n" +
  "[translate]\ntemperature = 0.2\n\n[align]\nthreshold = 0.6\n";

const SEGMENTS: Segment[] = [
  { index: 0, source: "First sentence.", target: "Translated first sentence.", confidence: 1 },
];

function reviewed(humanEdited: boolean, status: PendingArticle["status"]): PendingArticle {
  return {
    id: "p1",
    source: "test",
    url: "https://example.test/p1",
    title: "Building agents",
    published_at: "2024-05-14",
    raw_html_excerpt: "<p>A short summary.</p>",
    images: [],
    source_paragraphs: ["First sentence."],
    target_paragraphs: ["Translated first sentence."],
    target_language: "zh-CN",
    segments: SEGMENTS,
    human_edited: humanEdited,
    human_notes: "harness stays in English",
    translation_meta: null,
    status,
  };
}

async function makeRoot(article: PendingArticle): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blog-translate-publish-"));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config.toml"), CONFIG, "utf8");
  await writeFile(
    join(root, "config", "glossary.json"),
    JSON.stringify({ harness: { keep_original: true } }),
    "utf8",
  );
  await savePending(root, article);
  const index: ArticleIndex = {
    schema_version: 2,
    last_crawled_at: "2024-05-14T00:00:00.000Z",
    articles: [
      {
        id: article.id,
        source: article.source,
        url: article.url,
        title: article.title,
        published_at: article.published_at,
        tags: [],
        status: article.status,
        created_at: "2024-05-14T00:00:00.000Z",
        published_at_local: null,
      },
    ],
  };
  await saveIndex(root, index);
  return root;
}

test("unedited articles are rejected and keep their status", async () => {
  const article = reviewed(false, "aligned");
  const missing = validateForPublish(article);
  assert.ok(missing.includes("human_edited"));
  assert.ok(missing.includes("status=reviewed"));
  const root = await makeRoot(article);
  try {
    const result = await publishAll(root, { dryRun: false });
    assert.equal(result.failed, 1);
    assert.equal((await loadPending(root, "p1")).status, "aligned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish writes post, viewer, index, rss and about", async () => {
  const root = await makeRoot(reviewed(true, "reviewed"));
  try {
    const result = await publishAll(root, { dryRun: false });
    assert.equal(result.published, 1);
    assert.equal(result.failed, 0);
    const post = await readFile(join(root, "site", "posts", "building-agents.md"), "utf8");
    assert.match(post, /^---\n/);
    assert.match(post, /original_title:/);
    assert.match(post, /Translations are provided as-is/);
    assert.match(post, /\| harness \|/);
    const viewer = await readFile(join(root, "site", "viewers", "building-agents.html"), "utf8");
    assert.match(viewer, /First sentence\./);
    assert.match(viewer, /id="site-nav"/);
    const index = await readFile(join(root, "site", "index.md"), "utf8");
    assert.match(index, /building-agents\.html/);
    const indexHtml = await readFile(join(root, "site", "index.html"), "utf8");
    assert.match(indexHtml, /id="site-nav"/);
    assert.match(indexHtml, /building-agents\.html/);
    const postHtml = await readFile(join(root, "site", "posts", "building-agents.html"), "utf8");
    assert.match(postHtml, /id="site-nav"/);
    assert.match(postHtml, /Translation/);
    const aboutHtml = await readFile(join(root, "site", "about.html"), "utf8");
    assert.match(aboutHtml, /id="site-nav"/);
    const rss = await readFile(join(root, "site", "rss.xml"), "utf8");
    assert.match(rss, /<guid isPermaLink="false">p1<\/guid>/);
    assert.match(await readFile(join(root, "site", "about.md"), "utf8"), /Removal/);
    assert.equal((await loadPending(root, "p1")).status, "published");
    assert.equal((await loadIndex(root)).articles[0]?.status, "published");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish writes original images as markdown", async () => {
  const withImages = reviewed(true, "reviewed");
  withImages.images = [
    { url: "https://cdn.test/fig(1).png", alt: "A diagram", before_paragraph: 0 },
  ];
  const root = await makeRoot(withImages);
  try {
    const result = await publishAll(root, { dryRun: false });
    assert.equal(result.published, 1);
    const post = await readFile(join(root, "site", "posts", "building-agents.md"), "utf8");
    assert.match(post, /## Figures/);
    assert.match(post, /!\[A diagram\]\(https:\/\/cdn\.test\/fig%281%29\.png\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--dry-run reports without writing", async () => {
  const root = await makeRoot(reviewed(true, "reviewed"));
  try {
    const result = await publishAll(root, { dryRun: true, pr: false });
    assert.equal(result.published, 1);
    await assert.rejects(readFile(join(root, "site", "posts", "building-agents.md"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeArticle deletes outputs and marks the article removed", async () => {
  const root = await makeRoot(reviewed(true, "reviewed"));
  try {
    await publishAll(root, { dryRun: false, pr: false });
    await removeArticle(root, "p1");
    await assert.rejects(readFile(join(root, "site", "posts", "building-agents.md"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(root, "site", "posts", "building-agents.html"), "utf8"), {
      code: "ENOENT",
    });
    assert.equal((await loadPending(root, "p1")).status, "removed");
    assert.equal((await loadIndex(root)).articles[0]?.status, "removed");
    assert.ok(
      !(await readFile(join(root, "site", "index.md"), "utf8")).includes("building-agents.html"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listForReview filters by status", async () => {
  const root = await makeRoot(reviewed(true, "reviewed"));
  try {
    assert.equal((await listForReview(root, "reviewed")).length, 1);
    assert.equal((await listForReview(root, "pending")).length, 0);
    assert.equal((await listForReview(root, "all")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
