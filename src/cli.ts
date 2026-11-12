import { parseArgs } from "node:util";

export class CliError extends Error {}

export type Layout = "source-target" | "target-source";

export type Command =
  | {
      name: "crawl";
      source?: string;
      url?: string;
      dryRun: boolean;
      limit: number | null;
      json: boolean;
    }
  | {
      name: "translate";
      model?: string;
      endpoint?: string;
      language?: string;
      only?: string;
      source?: string;
      force: boolean;
      json: boolean;
    }
  | { name: "align"; only?: string; threshold?: number; json: boolean }
  | { name: "review"; status: string; edit?: string; json: boolean }
  | { name: "build-viewer"; article?: string; layout: Layout; json: boolean }
  | { name: "publish"; dryRun: boolean; remove?: string; json: boolean }
  | { name: "serve"; port: number; json: boolean }
  | { name: "status"; json: boolean };

const COMMANDS = [
  "crawl",
  "translate",
  "align",
  "review",
  "build-viewer",
  "publish",
  "serve",
  "status",
];

function positiveInt(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`invalid ${option} "${value}"`);
  }
  return parsed;
}

function fraction(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError(`invalid --threshold "${value}"`);
  }
  return parsed;
}

export function parseCommand(argv: string[]): Command {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      source: { type: "string" },
      url: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      model: { type: "string" },
      endpoint: { type: "string" },
      lang: { type: "string" },
      only: { type: "string" },
      force: { type: "boolean", default: false },
      threshold: { type: "string" },
      status: { type: "string", default: "all" },
      edit: { type: "string" },
      article: { type: "string" },
      layout: { type: "string", default: "source-target" },
      port: { type: "string", default: "8080" },
      remove: { type: "string" },
    },
  });

  const name = positionals[0];
  const extra = positionals[1];
  if (extra !== undefined) throw new CliError(`unexpected argument "${extra}"`);
  if (name === undefined) throw new CliError(`missing command; available: ${COMMANDS.join(", ")}`);
  if (!COMMANDS.includes(name)) {
    throw new CliError(`unknown command "${name}"; available: ${COMMANDS.join(", ")}`);
  }

  const json = values.json === true;
  const dryRun = values["dry-run"] === false ? false : values["dry-run"] === true;

  switch (name) {
    case "crawl":
      return {
        name,
        source: values.source,
        url: values.url,
        dryRun,
        limit: positiveInt(values.limit, "--limit") ?? null,
        json,
      };
    case "translate":
      return {
        name,
        model: values.model,
        endpoint: values.endpoint,
        language: values.lang,
        only: values.only,
        source: values.source,
        force: values.force === true,
        json,
      };
    case "align":
      return { name, only: values.only, threshold: fraction(values.threshold), json };
    case "review":
      return { name, status: values.status ?? "all", edit: values.edit, json };
    case "build-viewer": {
      const layout = values.layout ?? "source-target";
      if (layout !== "source-target" && layout !== "target-source") {
        throw new CliError(`invalid --layout "${layout}"`);
      }
      return { name, article: values.article, layout, json };
    }
    case "publish":
      return {
        name,
        dryRun,
        remove: values.remove,
        json,
      };
    case "serve": {
      const port = positiveInt(values.port, "--port") ?? 8080;
      if (port > 65535) throw new CliError(`invalid --port "${values.port}"`);
      return { name, port, json };
    }
    default:
      return { name: "status", json };
  }
}
