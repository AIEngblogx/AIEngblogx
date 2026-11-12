import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function appendLog(
  root: string,
  module: string,
  event: Record<string, unknown>,
): Promise<void> {
  const dir = join(root, "logs");
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  await appendFile(join(dir, `${module}.jsonl`), line, "utf8");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
