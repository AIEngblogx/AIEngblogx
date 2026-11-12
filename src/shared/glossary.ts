import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readGlossary(root: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(root, "config", "glossary.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
