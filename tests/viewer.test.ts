import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { escapeHtml } from "../src/publishing/site.ts";
import { buildViewers, renderViewer, safeJson } from "../src/publishing/viewer.ts";
import { type PendingArticle, type Segment, savePending } from "../src/shared/store.ts";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "blog-translate-viewer-"));
}

function article(status: PendingArticle["status"], segments: Segment[] = []): PendingArticle {
  return {
    id: "v1",
    source: "test",
    url: "https://example.test/v1",
    title: "Building agents",
    published_at: "2024-05-14",
    raw_html_excerpt: "summary",
    images: [],
    source_paragraphs: ["First sentence."],
    target_paragraphs: ["Translated first sentence."],
    target_language: "zh-CN",
    segments,
    human_edited: status === "reviewed",
    human_notes: "",
    translation_meta: null,
    status,
  };
}

const SEGMENTS: Segment[] = [
  { index: 0, source: "First sentence.", target: "Translated first sentence.", confidence: 1 },
  { index: 1, source: "Second sentence.", target: "Translated second sentence.", confidence: 1 },
];

test("viewer is a self-contained file with both panes and inline data", async () => {
  const root = await makeRoot();
  try {
    const html = await renderViewer(root, article("reviewed", SEGMENTS), "source-target");
    assert.ok(!html.includes("/assets/"));
    assert.match(html, /<style>[\s\S]*<\/style>/);
    assert.match(html, /<script>[\s\S]*<\/script>/);
    assert.match(html, /window\.__SEGMENTS__ = \[/);
    assert.match(html, /data-index/);
    assert.match(html, /aria-label="Source text"/);
    assert.match(html, /aria-label="Translation"/);
    assert.match(html, /Translations are provided as-is/);
    assert.match(html, /syncScroll/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /class="sidebar"/);
    assert.match(html, /id="site-nav"/);
    assert.match(html, /aria-label="Filter articles"/);
    assert.ok(!html.includes("{{segments_json}}"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer renders original images as sanitized external img tags", async () => {
  const root = await makeRoot();
  try {
    const withImages = article("reviewed", SEGMENTS);
    withImages.images = [
      { url: "https://cdn.test/diagram.png", alt: "A diagram", before_paragraph: 0 },
      { url: "javascript:alert(1)", alt: "unsafe", before_paragraph: 0 },
    ];
    const html = await renderViewer(root, withImages, "source-target");
    assert.match(html, /window\.__IMAGES__ = \[/);
    assert.match(html, /https:\/\/cdn\.test\/diagram\.png/);
    assert.match(html, /id="figures"/);
    assert.match(html, /parsed\.protocol !== "http:"/);
    assert.ok(!html.includes("{{images_json}}"));
    assert.ok(!html.includes('<img src="javascript'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline data cannot break out of the script tag", async () => {
  const root = await makeRoot();
  try {
    const hostile: Segment[] = [
      { index: 0, source: "</script><img src=x>", target: "Translation", confidence: 1 },
    ];
    const html = await renderViewer(root, article("reviewed", hostile), "target-source");
    assert.ok(html.includes("\\u003c/script\\u003e"));
    assert.match(html, /data-layout="target-source"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaping helpers cover html and json boundaries", () => {
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.equal(safeJson({ text: "</script>" }), '{"text":"\\u003c/script\\u003e"}');
});

test("buildViewers writes only reviewed articles", async () => {
  const root = await makeRoot();
  try {
    await savePending(root, article("pending", SEGMENTS));
    assert.deepEqual(await buildViewers(root, { layout: "source-target" }), {
      built: 0,
      skipped: 1,
      failed: 0,
    });
    await savePending(root, article("reviewed", SEGMENTS));
    assert.deepEqual(await buildViewers(root, { layout: "source-target" }), {
      built: 1,
      skipped: 0,
      failed: 0,
    });
    const output = await readFile(join(root, "site", "viewers", "building-agents.html"), "utf8");
    assert.ok(Buffer.byteLength(output, "utf8") < 200 * 1024);
    assert.match(output, /Second sentence\./);
    assert.match(output, /"index":1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer over 200kb is rejected", async () => {
  const root = await makeRoot();
  try {
    const huge: Segment[] = [
      { index: 0, source: "x".repeat(210 * 1024), target: "Translation", confidence: 1 },
    ];
    await assert.rejects(
      renderViewer(root, article("reviewed", huge), "source-target"),
      /exceeds 200kb/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
