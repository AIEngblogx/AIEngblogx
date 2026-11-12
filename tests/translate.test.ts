import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type ArticleIndex,
  loadPending,
  type PendingArticle,
  saveIndex,
  savePending,
} from "../src/shared/store.ts";
import { translateAll } from "../src/translation/translate.ts";

let server: Server;
let baseUrl = "";
let requests: { temperature: number; messages: { role: string; content: string }[] }[] = [];
let failCount = 0;

before(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as never);
    if (failCount > 0) {
      failCount -= 1;
      response.writeHead(503);
      response.end("");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "First translated paragraph. Harness stays in English.\n\nSecond translated paragraph.",
            },
          },
        ],
        usage: { total_tokens: 42 },
      }),
    );
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

const CONFIG =
  '[[sources]]\nname = "test"\nlist_url = "https://example.test"\n\n' +
  "[crawl]\nrespect_robots = true\nfetch_full_text = true\nrequest_delay_ms = 0\n\n" +
  "[translate]\ntemperature = 0.2\n\n[align]\nthreshold = 0.6\n";

async function makeRoot(count: number): Promise<{ root: string; ids: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "blog-translate-translate-"));
  await writeFile(join(root, "config.toml"), CONFIG, "utf8");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(
    join(root, "config", "glossary.json"),
    JSON.stringify({ harness: { keep_original: true } }),
    "utf8",
  );
  const index: ArticleIndex = { schema_version: 2, last_crawled_at: null, articles: [] };
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `t${i}`;
    const article: PendingArticle = {
      id,
      source: "test",
      url: `https://example.test/${i}`,
      title: `Article ${i}`,
      published_at: "2024-05-14",
      raw_html_excerpt: "summary",
      images: [],
      source_paragraphs: ["First paragraph with enough words here.", "Second paragraph here."],
      target_paragraphs: [],
      target_language: "zh-CN",
      segments: [],
      human_edited: false,
      human_notes: "",
      translation_meta: null,
      status: "pending",
    };
    await savePending(root, article);
    index.articles.push({
      id,
      source: "test",
      url: article.url,
      title: article.title,
      published_at: article.published_at,
      tags: [],
      status: "pending",
      created_at: "2024-05-14T00:00:00.000Z",
      published_at_local: null,
    });
    ids.push(id);
  }
  await saveIndex(root, index);
  return { root, ids };
}

test("translation fills target paragraphs, metadata and glossary prompt", async () => {
  const { root, ids } = await makeRoot(1);
  requests = [];
  try {
    const result = await translateAll({
      root,
      endpoint: `${baseUrl}/v1`,
      model: "test-model",
      force: false,
    });
    assert.deepEqual(result, { translated: 1, skipped: 0, failed: 0 });
    const article = await loadPending(root, ids[0] ?? "");
    assert.equal(article.status, "translated");
    assert.equal(article.target_paragraphs.length, article.source_paragraphs.length);
    assert.equal(article.translation_meta?.model, "test-model");
    assert.ok((article.translation_meta?.tokens ?? 0) >= 42);
    const sent = requests[0];
    assert.ok(sent !== undefined);
    assert.equal(sent.temperature, 0.2);
    assert.match(sent.messages[0]?.content ?? "", /preserve structure/);
    assert.match(sent.messages[1]?.content ?? "", /harness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each paragraph is sent as its own request", async () => {
  const { root } = await makeRoot(1);
  requests = [];
  try {
    await translateAll({ root, endpoint: `${baseUrl}/v1`, model: "test-model", force: false });
    assert.equal(requests.length, 2);
    const sent = requests.map((request) => request.messages[1]?.content ?? "").join("\n");
    assert.match(sent, /First paragraph/);
    assert.match(sent, /Second paragraph/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one failing article does not stop the others", async () => {
  const { root, ids } = await makeRoot(2);
  failCount = 6;
  try {
    const result = await translateAll({
      root,
      endpoint: `${baseUrl}/v1`,
      model: "test-model",
      force: false,
    });
    assert.equal(result.failed, 1);
    assert.equal(result.translated, 1);
    const states = await Promise.all(ids.map((id) => loadPending(root, id)));
    assert.equal(states.filter((article) => article.status === "translated").length, 1);
  } finally {
    failCount = 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("--force only reruns translated articles", async () => {
  const { root } = await makeRoot(1);
  try {
    await translateAll({ root, endpoint: `${baseUrl}/v1`, model: "test-model", force: false });
    assert.equal(
      (await translateAll({ root, endpoint: `${baseUrl}/v1`, model: "test-model", force: false }))
        .skipped,
      1,
    );
    assert.equal(
      (await translateAll({ root, endpoint: `${baseUrl}/v1`, model: "test-model", force: true }))
        .translated,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--source limits translation to one source", async () => {
  const { root, ids } = await makeRoot(2);
  const other = await loadPending(root, ids[1] ?? "");
  other.source = "another-source";
  await savePending(root, other);
  try {
    const result = await translateAll({
      root,
      endpoint: `${baseUrl}/v1`,
      model: "test-model",
      source: "test",
      force: false,
    });
    assert.equal(result.translated, 1);
    assert.equal((await loadPending(root, ids[1] ?? "")).status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("translation requires a model from the caller or the environment", async () => {
  const { root } = await makeRoot(1);
  const saved = process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_MODEL;
  try {
    await assert.rejects(
      translateAll({ root, endpoint: `${baseUrl}/v1`, force: false }),
      /OLLAMA_MODEL/,
    );
  } finally {
    if (saved !== undefined) process.env.OLLAMA_MODEL = saved;
    await rm(root, { recursive: true, force: true });
  }
});
