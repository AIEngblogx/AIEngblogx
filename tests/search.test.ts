import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchIndex, rankRecords, searchIndex, tokenize } from "../src/publishing/search.ts";
import { renderShell, SITE_JS } from "../src/publishing/site.ts";
import type { ArticleIndex } from "../src/shared/store.ts";

const INDEX = buildSearchIndex([
  {
    title: "Building agents",
    href: "viewers/building-agents.html",
    paragraphs: [
      { target: "代理人需要上下文窗口", source: "Agents need a context window" },
      { target: "缓存优化", source: "A caching optimization that dropped prior reasoning" },
    ],
  },
  {
    title: "Caching notes",
    href: "viewers/caching-notes.html",
    paragraphs: [{ target: "缓存笔记", source: "Notes about caching" }],
  },
]);

const EMPTY_INDEX: ArticleIndex = { schema_version: 2, last_crawled_at: null, articles: [] };

test("tokenizer keeps ascii words whole and splits CJK into bigrams", () => {
  assert.deepEqual(tokenize("Claude Code's window"), ["claude", "code", "s", "window"]);
  assert.deepEqual(tokenize("上下文窗口"), ["上下", "下文", "文窗", "窗口"]);
  assert.deepEqual(tokenize("Claude 上下文 window"), ["claude", "上下", "下文", "window"]);
  assert.deepEqual(tokenize("!!!"), []);
  assert.deepEqual(tokenize("代理"), ["代理"]);
});

test("index stores title records, paragraph texts and term frequencies", () => {
  assert.equal(INDEX.version, 1);
  assert.equal(INDEX.documents.length, 2);
  assert.equal(INDEX.records.length, 5);
  assert.deepEqual(INDEX.records[0], [0, -1, "Building agents", ""]);
  assert.deepEqual(INDEX.records[1], [
    0,
    0,
    "代理人需要上下文窗口",
    "Agents need a context window",
  ]);
  assert.equal(INDEX.postings.building?.[0]?.[0], 0);
  assert.equal(INDEX.postings.上下文, undefined);
  assert.ok(Array.isArray(INDEX.postings.上下));
});

test("chinese query ranks the matching paragraph first with a paragraph anchor", () => {
  const hits = searchIndex(INDEX, "上下文窗口");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.href, "viewers/building-agents.html");
  assert.equal(hits[0]?.anchor, "p-0");
  assert.match(hits[0]?.target ?? "", /上下文窗口/);
});

test("english query reaches both the translated source text and the title", () => {
  const hits = searchIndex(INDEX, "caching");
  assert.ok(hits.some((hit) => hit.href.includes("building-agents")));
  assert.ok(hits.some((hit) => hit.href.includes("caching-notes")));
  assert.ok(hits.some((hit) => hit.anchor === ""));
});

test("empty and prototype-shaped queries are handled safely", () => {
  assert.deepEqual(searchIndex(INDEX, ""), []);
  assert.deepEqual(rankRecords(INDEX, "__proto__", 8), []);
  assert.deepEqual(searchIndex(INDEX, "没有任何命中词的句子"), []);
});

test("browser bundle uses the exact same tokenizer and ranker as the builder", () => {
  assert.ok(SITE_JS.includes(tokenize.toString()));
  assert.ok(SITE_JS.includes(rankRecords.toString()));
});

test("shell exposes theme controls, full-text search panel and the index path", () => {
  const html = renderShell({
    title: "Contents",
    heading: "Contents",
    subline: "",
    prefix: "../",
    activeHref: "index.html",
    index: EMPTY_INDEX,
    content: "<p>body</p>",
    searchIndexHref: "search-index.json",
  });
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /id="search-panel"/);
  assert.match(html, /role="status"/);
  assert.match(html, /data-theme/);
  assert.match(html, /data-prefix="\.\.\/"/);
  assert.match(html, /data-search-index="search-index\.json"/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /aria-label="Search articles"/);
  assert.match(html, /<h1>Contents<\/h1>/);
  const withoutIndex = renderShell({
    title: "Contents",
    heading: "Contents",
    subline: "",
    prefix: "",
    activeHref: "index.html",
    index: EMPTY_INDEX,
    content: "<p>body</p>",
  });
  assert.match(withoutIndex, /data-search-index=""/);
});
