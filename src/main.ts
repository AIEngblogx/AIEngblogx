#!/usr/bin/env node
import { CliError, type Command, parseCommand } from "./cli.ts";
import { CrawlError, crawlOnce } from "./crawler/crawl.ts";
import { publishAll, removeArticle } from "./publishing/publish.ts";
import { serve } from "./publishing/serve.ts";
import { buildViewers } from "./publishing/viewer.ts";
import { ConfigError } from "./shared/config.ts";
import { messageOf } from "./shared/log.ts";
import { loadIndex } from "./shared/store.ts";
import { alignAll } from "./translation/align.ts";
import { editArticle, listForReview } from "./translation/review.ts";
import { translateAll } from "./translation/translate.ts";

const root = process.cwd();

function emit(json: boolean, payload: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(payload)}\n` : `${text}\n`);
}

async function status(json: boolean): Promise<void> {
  const index = await loadIndex(root);
  const counts: Record<string, number> = {};
  for (const article of index.articles) {
    counts[article.status] = (counts[article.status] ?? 0) + 1;
  }
  const payload = {
    total: index.articles.length,
    last_crawled_at: index.last_crawled_at,
    counts,
  };
  emit(
    json,
    payload,
    `total=${payload.total} last_crawled_at=${payload.last_crawled_at ?? "never"}\n` +
      Object.entries(counts)
        .map(([key, value]) => `  ${key}=${value}`)
        .join("\n"),
  );
}

async function run(command: Command): Promise<void> {
  switch (command.name) {
    case "status":
      await status(command.json);
      return;
    case "crawl": {
      const result = await crawlOnce({
        root,
        source: command.source,
        url: command.url,
        dryRun: command.dryRun,
        limit: command.limit,
      });
      emit(
        command.json,
        result,
        `new=${result.new} skipped=${result.skipped} failed=${result.failed}`,
      );
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    case "translate": {
      const result = await translateAll({
        root,
        model: command.model,
        endpoint: command.endpoint,
        language: command.language,
        source: command.source,
        only: command.only,
        force: command.force,
      });
      emit(
        command.json,
        result,
        `translated=${result.translated} skipped=${result.skipped} failed=${result.failed}`,
      );
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    case "align": {
      const result = await alignAll({ root, only: command.only, threshold: command.threshold });
      emit(
        command.json,
        result,
        `aligned=${result.aligned} skipped=${result.skipped} failed=${result.failed} degraded=${result.degraded}`,
      );
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    case "review": {
      if (command.edit !== undefined) {
        const result = await editArticle(root, command.edit);
        emit(command.json, result, `reviewed=${result.id} edited=${result.edited}`);
        return;
      }
      const rows = await listForReview(root, command.status);
      emit(
        command.json,
        rows,
        rows.map((row) => `${row.id} ${row.status} ${row.title}`).join("\n"),
      );
      return;
    }
    case "build-viewer": {
      const result = await buildViewers(root, {
        article: command.article,
        layout: command.layout,
      });
      emit(
        command.json,
        result,
        `built=${result.built} skipped=${result.skipped} failed=${result.failed}`,
      );
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    case "publish": {
      if (command.remove !== undefined) {
        const result = await removeArticle(root, command.remove);
        emit(command.json, result, `removed=${result.id}`);
        return;
      }
      const result = await publishAll(root, { dryRun: command.dryRun });
      emit(
        command.json,
        result,
        `published=${result.published} skipped=${result.skipped} failed=${result.failed}`,
      );
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    case "serve":
      await serve(root, command.port);
      return;
  }
}

run(parseCommand(process.argv.slice(2))).catch((error: unknown) => {
  const message = messageOf(error);
  process.stderr.write(`error: ${message}\n`);
  if (error instanceof CrawlError) {
    process.exitCode = error.exitCode;
  } else if (error instanceof CliError || error instanceof ConfigError) {
    process.exitCode = 2;
  } else {
    process.exitCode = 2;
  }
});
