import { createInterface } from "node:readline/promises";
import { appendLog, messageOf } from "../shared/log.ts";
import { listPendingIds, loadPending, type PendingArticle, savePending } from "../shared/store.ts";

export function validateForPublish(article: PendingArticle): string[] {
  const missing: string[] = [];
  if (article.url === "") missing.push("url");
  if (article.title === "") missing.push("title");
  if (article.published_at === "") missing.push("published_at");
  if (article.segments.length === 0) missing.push("segments");
  if (!article.human_edited) missing.push("human_edited");
  if (article.status !== "reviewed") missing.push("status=reviewed");
  return missing;
}

export interface ReviewRow {
  id: string;
  status: string;
  title: string;
  segments: number;
}

export async function listForReview(root: string, status: string): Promise<ReviewRow[]> {
  const rows: ReviewRow[] = [];
  for (const id of await listPendingIds(root)) {
    try {
      const article = await loadPending(root, id);
      if (status === "all" || article.status === status) {
        rows.push({
          id,
          status: article.status,
          title: article.title,
          segments: article.segments.length,
        });
      }
    } catch (error) {
      await appendLog(root, "review", { event: "load_failed", id, error: messageOf(error) });
    }
  }
  return rows;
}

export async function editArticle(
  root: string,
  id: string,
): Promise<{ id: string; edited: number }> {
  const article = await loadPending(root, id);
  if (article.segments.length === 0) {
    throw new Error(`no segments for ${id}; run align first`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let edited = 0;
  try {
    for (const segment of article.segments) {
      process.stdout.write(
        `[${segment.index}] Source: ${segment.source}\n    Target: ${segment.target}\n` +
          "    (e) edit  (k) keep  (n) note  (q) quit\n",
      );
      const answer = (await rl.question("> ")).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "e") {
        segment.target = (await rl.question("target> ")).trim();
        article.human_edited = true;
        edited += 1;
      } else if (answer === "n") {
        article.human_notes = (await rl.question("note> ")).trim();
        article.human_edited = true;
        edited += 1;
      }
    }
  } finally {
    rl.close();
  }

  if (article.human_edited) {
    article.status = "reviewed";
    await savePending(root, article);
    await appendLog(root, "review", { event: "reviewed", id, edited });
  }
  return { id, edited };
}
