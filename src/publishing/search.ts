export interface SearchParagraph {
  target: string;
  source: string;
}

export interface SearchDocumentInput {
  title: string;
  href: string;
  paragraphs: SearchParagraph[];
}

export type SearchRecord = [number, number, string, string];

export interface SearchIndex {
  version: 1;
  documents: { title: string; href: string }[];
  records: SearchRecord[];
  postings: Record<string, [number, number][]>;
}

export interface SearchHit {
  title: string;
  href: string;
  anchor: string;
  target: string;
  source: string;
}

// ASCII words stay whole; CJK runs are split into bigrams so Chinese queries work
// without a dictionary or a tokenizer dependency. This function is embedded verbatim
// in the browser bundle via Function.prototype.toString(), so it must stay self-contained.
export function tokenize(text: string): string[] {
  const input = String(text).toLowerCase();
  const chunks =
    input.match(/[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (/^[a-z0-9_]/.test(chunk)) {
      tokens.push(chunk);
      continue;
    }
    const characters = Array.from(chunk);
    if (characters.length === 1) {
      tokens.push(characters[0] ?? "");
      continue;
    }
    for (let i = 0; i < characters.length - 1; i++) {
      tokens.push((characters[i] ?? "") + (characters[i + 1] ?? ""));
    }
  }
  return tokens;
}

// Also embedded verbatim in the browser bundle: keep it self-contained and free of
// template literals so it can be injected inside a <script> template string.
export function rankRecords(index: SearchIndex, query: string, limit: number): number[] {
  const tokens = Array.from(new Set(tokenize(query))).slice(0, 8);
  if (tokens.length === 0) return [];
  const total = index.records.length;
  const scores = new Map<number, { score: number; matched: number }>();
  for (const token of tokens) {
    const list = index.postings[token];
    if (!Array.isArray(list)) continue;
    const idf = Math.log(1 + total / (1 + list.length));
    for (const posting of list) {
      const current = scores.get(posting[0]) ?? { score: 0, matched: 0 };
      current.score += idf * (1 + Math.log(posting[1]));
      current.matched += 1;
      scores.set(posting[0], current);
    }
  }
  const ranked: { record: number; score: number }[] = [];
  for (const [record, value] of scores) {
    let score = value.score;
    if (value.matched === tokens.length) score *= 1.6;
    const fields = index.records[record];
    if (fields !== undefined && fields[1] === -1) score *= 1.25;
    ranked.push({ record, score });
  }
  ranked.sort((left, right) => right.score - left.score);
  const perDocument = new Map<number, number>();
  const hits: number[] = [];
  for (const item of ranked) {
    const fields = index.records[item.record];
    if (fields === undefined) continue;
    const count = perDocument.get(fields[0]) ?? 0;
    if (count >= 2) continue;
    perDocument.set(fields[0], count + 1);
    hits.push(item.record);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function buildSearchIndex(documents: SearchDocumentInput[]): SearchIndex {
  const result: SearchIndex = {
    version: 1,
    documents: [],
    records: [],
    postings: Object.create(null) as SearchIndex["postings"],
  };
  const add = (doc: number, paragraph: number, target: string, source: string): void => {
    const record = result.records.length;
    result.records.push([doc, paragraph, target, source]);
    const counts = new Map<string, number>();
    for (const token of [...tokenize(target), ...tokenize(source)]) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, frequency] of counts) {
      const list = result.postings[token] ?? [];
      list.push([record, frequency]);
      result.postings[token] = list;
    }
  };
  for (let doc = 0; doc < documents.length; doc++) {
    const document = documents[doc];
    if (document === undefined) continue;
    result.documents.push({ title: document.title, href: document.href });
    add(doc, -1, document.title, "");
    for (let paragraph = 0; paragraph < document.paragraphs.length; paragraph++) {
      const pair = document.paragraphs[paragraph];
      if (pair === undefined) continue;
      add(doc, paragraph, pair.target, pair.source);
    }
  }
  return result;
}

export function searchIndex(index: SearchIndex, query: string, limit = 8): SearchHit[] {
  return rankRecords(index, query, limit).flatMap((recordIndex) => {
    const record = index.records[recordIndex];
    if (record === undefined) return [];
    const document = index.documents[record[0]];
    if (document === undefined) return [];
    return [
      {
        title: document.title,
        href: document.href,
        anchor: record[1] < 0 ? "" : `p-${record[1]}`,
        target: record[2],
        source: record[3],
      },
    ];
  });
}
