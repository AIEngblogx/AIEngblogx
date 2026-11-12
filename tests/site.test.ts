import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/publishing/serve.ts";

let server: Server;
let baseUrl = "";
let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "blog-translate-serve-"));
  await mkdir(join(root, "site"), { recursive: true });
  await writeFile(join(root, "site", "index.md"), "# index\n", "utf8");
  await writeFile(join(root, "site", "reader.html"), "<!doctype html>\n", "utf8");
  await writeFile(join(root, "config.toml"), "secret = 1\n", "utf8");
  server = createServer((request, response) => {
    void createHandler(root)(request, response);
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
  await rm(root, { recursive: true, force: true });
});

test("static server maps / to the index and serves html", async () => {
  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/markdown/);
  assert.equal(await index.text(), "# index\n");
  const html = await fetch(`${baseUrl}/reader.html`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
});

test("index.html is served before the legacy markdown index", async () => {
  const path = join(root, "site", "index.html");
  await writeFile(path, "<!doctype html><title>book</title>\n", "utf8");
  try {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /book/);
  } finally {
    await rm(path, { force: true });
  }
});

test("path traversal and missing files are rejected", async () => {
  const traversal = await fetch(`${baseUrl}/%2e%2e%2fconfig.toml`);
  assert.equal(traversal.status, 403);
  const missing = await fetch(`${baseUrl}/missing.html`);
  assert.equal(missing.status, 404);
});
