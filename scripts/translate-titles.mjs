import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const model = process.argv[2] ?? process.env.OLLAMA_MODEL;
const endpoint = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
if (!model) {
  console.error("usage: node scripts/translate-titles.mjs <model>");
  process.exit(1);
}

const SYSTEM_PROMPT =
  "Translate the article title into Simplified Chinese. Output only the translated title, " +
  "without quotes or notes. Keep product names, model names and code identifiers unchanged.";

const index = JSON.parse(await readFile(join(root, "data", "articles.json"), "utf8"));
let translated = 0;
let present = 0;
let failed = 0;

for (const article of index.articles) {
  const path = join(root, "inbox", "pending", `${article.id}.json`);
  let pending;
  try {
    pending = JSON.parse(await readFile(path, "utf8"));
  } catch {
    continue;
  }
  if (typeof pending.target_title === "string" && pending.target_title !== "") {
    present += 1;
    continue;
  }
  if ((pending.source_paragraphs ?? []).length < 3) continue;
  if ((pending.target_paragraphs ?? []).length !== pending.source_paragraphs.length) continue;

  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: article.title },
        ],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const title = String(body.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^["'「『]+|["'」』]+$/g, "")
      .split("\n")[0]
      .trim();
    if (title === "") throw new Error("empty title");
    pending.target_title = title;
    await writeFile(path, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
    translated += 1;
  } catch (error) {
    failed += 1;
    console.error(`${article.id}: ${String(error)}`);
  }
}

console.log(`titles: ${translated} translated, ${present} already present, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
