import { readConfig } from "../shared/config.ts";
import { appendLog, messageOf } from "../shared/log.ts";
import {
  listPendingIds,
  loadPending,
  type PendingArticle,
  type Segment,
  savePending,
} from "../shared/store.ts";

export interface AlignOptions {
  root: string;
  only?: string;
  threshold?: number;
}

export interface AlignResult {
  aligned: number;
  skipped: number;
  failed: number;
  degraded: number;
}

export interface AlignOutcome {
  segments: Segment[];
  degraded: boolean;
}

export function splitSentences(paragraphs: string[]): string[] {
  return paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/(?<=[.!?。！？；])\s*/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== ""),
  );
}

function similarity(a: string, b: string): number {
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length, 1);
  const numbersA: string[] = a.match(/\d+/g) ?? [];
  const numbersB: string[] = b.match(/\d+/g) ?? [];
  const sharedNumbers = numbersA.filter((value) => numbersB.includes(value)).length;
  const numbers =
    numbersA.length === 0 && numbersB.length === 0
      ? 0.5
      : sharedNumbers / Math.max(numbersA.length, numbersB.length, 1);
  const wordsA: string[] = a.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const wordsB: string[] = b.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const sharedWords = wordsA.filter((word) => wordsB.includes(word)).length;
  const terms =
    wordsA.length === 0 && wordsB.length === 0
      ? 0.5
      : sharedWords / Math.max(wordsA.length, wordsB.length, 1);
  return 0.7 * ratio + 0.15 * numbers + 0.15 * terms;
}

export function alignSentences(
  source: string[],
  target: string[],
  threshold: number,
): AlignOutcome {
  if (source.length === 0 || target.length === 0) {
    return {
      segments: [{ index: 0, source: source.join(" "), target: target.join(" "), confidence: 0 }],
      degraded: true,
    };
  }
  if (source.length === target.length) {
    return {
      segments: source.map((sentence, index) => ({
        index,
        source: sentence,
        target: target[index] ?? "",
        confidence: 1,
      })),
      degraded: false,
    };
  }

  const n = source.length;
  const m = target.length;
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  const choice = new Uint8Array((n + 1) * width);
  const at = (i: number, j: number): number => i * width + j;
  for (let i = 1; i <= n; i++) {
    score[at(i, 0)] = -0.25 * i;
    choice[at(i, 0)] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[at(0, j)] = -0.25 * j;
    choice[at(0, j)] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match =
        (score[at(i - 1, j - 1)] ?? 0) + similarity(source[i - 1] ?? "", target[j - 1] ?? "");
      const skipSource = (score[at(i - 1, j)] ?? 0) - 0.25;
      const skipTarget = (score[at(i, j - 1)] ?? 0) - 0.25;
      let best = match;
      let direction = 0;
      if (skipSource > best) {
        best = skipSource;
        direction = 1;
      }
      if (skipTarget > best) {
        best = skipTarget;
        direction = 2;
      }
      score[at(i, j)] = best;
      choice[at(i, j)] = direction;
    }
  }

  const pairs: { source: string; target: string; confidence: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const direction = choice[at(i, j)];
    if (i > 0 && j > 0 && direction === 0) {
      const left = source[i - 1] ?? "";
      const right = target[j - 1] ?? "";
      pairs.push({ source: left, target: right, confidence: similarity(left, right) });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || direction === 1)) {
      pairs.push({ source: source[i - 1] ?? "", target: "", confidence: 0 });
      i -= 1;
    } else {
      pairs.push({ source: "", target: target[j - 1] ?? "", confidence: 0 });
      j -= 1;
    }
  }
  pairs.reverse();

  const degraded = pairs.some(
    (pair) => pair.confidence < threshold || pair.source === "" || pair.target === "",
  );
  if (degraded) {
    return {
      segments: [
        {
          index: 0,
          source: pairs
            .map((pair) => pair.source)
            .filter((text) => text !== "")
            .join(" "),
          target: pairs
            .map((pair) => pair.target)
            .filter((text) => text !== "")
            .join(" "),
          confidence: 0,
        },
      ],
      degraded: true,
    };
  }
  return {
    segments: pairs.map((pair, index) => ({
      index,
      source: pair.source,
      target: pair.target,
      confidence: pair.confidence,
    })),
    degraded: false,
  };
}

export async function alignAll(options: AlignOptions): Promise<AlignResult> {
  const { root } = options;
  const config = await readConfig(root);
  const threshold = options.threshold ?? config.align.threshold;
  const ids = options.only === undefined ? await listPendingIds(root) : [options.only];
  const result: AlignResult = { aligned: 0, skipped: 0, failed: 0, degraded: 0 };

  for (const id of ids) {
    let article: PendingArticle;
    try {
      article = await loadPending(root, id);
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "align", { event: "load_failed", id, error: messageOf(error) });
      continue;
    }
    if (article.status !== "translated" && article.status !== "aligned") {
      result.skipped += 1;
      continue;
    }
    try {
      const outcome = alignSentences(
        splitSentences(article.source_paragraphs),
        splitSentences(article.target_paragraphs),
        threshold,
      );
      article.segments = outcome.segments;
      article.status = "aligned";
      await savePending(root, article);
      result.aligned += 1;
      if (outcome.degraded) {
        result.degraded += 1;
        await appendLog(root, "align", { event: "degraded", id, threshold });
      }
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "align", { event: "align_error", id, error: messageOf(error) });
    }
  }
  return result;
}
