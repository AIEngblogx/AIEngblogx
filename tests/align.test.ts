import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPending, type PendingArticle, savePending } from "../src/shared/store.ts";
import { alignAll, alignSentences, splitSentences } from "../src/translation/align.ts";

const CONFIG =
  '[[sources]]\nname = "test"\nlist_url = "https://example.test"\n\n' +
  "[crawl]\nrespect_robots = true\nfetch_full_text = true\nrequest_delay_ms = 0\n\n" +
  "[translate]\ntemperature = 0.2\n\n[align]\nthreshold = 0.6\n";

test("equal sentence counts produce one-to-one segments", () => {
  const outcome = alignSentences(
    ["First sentence.", "Second sentence."],
    ["Translated first sentence.", "Translated second sentence."],
    0.6,
  );
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.segments.length, 2);
  assert.deepEqual(
    outcome.segments.map((segment) => segment.confidence),
    [1, 1],
  );
  assert.equal(outcome.segments[1]?.target, "Translated second sentence.");
});

test("unequal counts degrade to paragraph level without undefined text", () => {
  const source = Array.from({ length: 12 }, (_, index) => `English sentence ${index + 1}.`);
  const target = Array.from({ length: 11 }, (_, index) => `Translated sentence ${index + 1}.`);
  const outcome = alignSentences(source, target, 0.6);
  assert.equal(outcome.degraded, true);
  assert.ok(outcome.segments.length > 0);
  for (const segment of outcome.segments) {
    assert.equal(typeof segment.source, "string");
    assert.equal(typeof segment.target, "string");
    assert.ok(!segment.source.includes("undefined"));
    assert.ok(!segment.target.includes("undefined"));
  }
});

test("sentence splitting keeps punctuation and drops blanks", () => {
  assert.deepEqual(splitSentences(["One. Two!  Three? "]), ["One.", "Two!", "Three?"]);
  assert.deepEqual(splitSentences(["First sentence. Second sentence!"]), [
    "First sentence.",
    "Second sentence!",
  ]);
});

test("alignAll writes segments and moves status to aligned", async () => {
  const root = await mkdtemp(join(tmpdir(), "blog-translate-align-"));
  try {
    await writeFile(join(root, "config.toml"), CONFIG, "utf8");
    const article: PendingArticle = {
      id: "a1",
      source: "test",
      url: "https://example.test/a",
      title: "A",
      published_at: "2024-05-14",
      raw_html_excerpt: "summary",
      images: [],
      source_paragraphs: ["First sentence.", "Second sentence."],
      target_paragraphs: ["Translated first sentence.", "Translated second sentence."],
      target_language: "zh-CN",
      segments: [],
      human_edited: false,
      human_notes: "",
      translation_meta: null,
      status: "translated",
    };
    await savePending(root, article);
    const result = await alignAll({ root });
    assert.deepEqual(result, { aligned: 1, skipped: 0, failed: 0, degraded: 0 });
    const stored = await loadPending(root, "a1");
    assert.equal(stored.status, "aligned");
    assert.equal(stored.segments.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
