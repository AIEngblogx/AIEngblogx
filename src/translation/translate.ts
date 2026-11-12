import { readConfig } from "../shared/config.ts";
import { readGlossary } from "../shared/glossary.ts";
import { languageName } from "../shared/languages.ts";
import { appendLog, messageOf } from "../shared/log.ts";
import { listPendingIds, loadPending, type PendingArticle, savePending } from "../shared/store.ts";

export interface TranslateOptions {
  root: string;
  model?: string;
  language?: string;
  only?: string;
  source?: string;
  force: boolean;
  endpoint?: string;
}

export interface TranslateResult {
  translated: number;
  skipped: number;
  failed: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { total_tokens?: number };
}

const CHAT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 4;

const SYSTEM_PROMPT =
  "You are a professional technical translator. Rules: 1) preserve structure and code blocks; 2) keep glossary terms marked keep_original in the source language; 3) do not add or omit information; 4) output only the translation of this paragraph, without labels, notes, or merged paragraphs.";

function messagesFor(paragraph: string, glossary: unknown, language: string) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `<glossary>\n${JSON.stringify(glossary)}\n</glossary>\n\n` +
        `Translate the following paragraph into ${languageName(language)}.\n\n` +
        `<text>\n${paragraph}\n</text>`,
    },
  ];
}

async function callChat(
  endpoint: string,
  model: string,
  temperature: number,
  paragraph: string,
  glossary: unknown,
  language: string,
): Promise<{ content: string; tokens: number }> {
  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: messagesFor(paragraph, glossary, language),
          temperature,
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`http ${response.status} from ${endpoint}`);
      const data = (await response.json()) as ChatResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error(`empty translation from ${endpoint}`);
      }
      return { content, tokens: data.usage?.total_tokens ?? 0 };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function translateAll(options: TranslateOptions): Promise<TranslateResult> {
  const { root } = options;
  const config = await readConfig(root);
  const endpoint = options.endpoint ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const model = options.model ?? process.env.OLLAMA_MODEL ?? "";
  if (model === "") {
    throw new Error("missing translation model; pass --model or set OLLAMA_MODEL");
  }
  const language = options.language ?? config.translate.target_languages[0] ?? "zh-CN";
  const quant = process.env.OLLAMA_QUANT ?? "Q4_K_M";
  const glossary = await readGlossary(root);
  const ids = options.only === undefined ? await listPendingIds(root) : [options.only];
  const result: TranslateResult = { translated: 0, skipped: 0, failed: 0 };

  for (const id of ids) {
    let article: PendingArticle;
    try {
      article = await loadPending(root, id);
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "translate", { event: "load_failed", id, error: messageOf(error) });
      continue;
    }
    if (options.source !== undefined && article.source !== options.source) continue;

    const eligible =
      article.status === "pending" || (options.force && article.status === "translated");
    if (!eligible) {
      result.skipped += 1;
      continue;
    }
    if (article.source_paragraphs.length === 0) {
      result.failed += 1;
      await appendLog(root, "translate", { event: "empty_source", id });
      continue;
    }

    try {
      const started = Date.now();
      const paragraphs = article.source_paragraphs;
      const translated: string[] = new Array<string>(paragraphs.length);
      let tokens = 0;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < paragraphs.length) {
          const index = next;
          next += 1;
          const paragraph = paragraphs[index];
          if (paragraph === undefined) continue;
          const reply = await callChat(
            endpoint,
            model,
            config.translate.temperature,
            paragraph,
            glossary,
            language,
          );
          translated[index] = reply.content.trim();
          tokens += reply.tokens;
        }
      };
      const outcomes = await Promise.allSettled(
        Array.from({ length: Math.min(CONCURRENCY, paragraphs.length) }, () => worker()),
      );
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
      article.target_paragraphs = translated;
      article.target_language = language;
      article.translation_meta = {
        model,
        quant,
        language,
        elapsed_ms: Date.now() - started,
        tokens,
      };
      article.status = "translated";
      await savePending(root, article);
      result.translated += 1;
      await appendLog(root, "translate", {
        event: "translated",
        id,
        model,
        language,
        paragraphs: translated.length,
        tokens,
      });
    } catch (error) {
      result.failed += 1;
      await appendLog(root, "translate", {
        event: "translation_error",
        id,
        error: messageOf(error),
      });
    }
  }
  return result;
}
