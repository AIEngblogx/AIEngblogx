import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export function createHandler(root: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    let relative: string;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
    } catch {
      response.writeHead(400);
      response.end("bad request");
      return;
    }
    const site = resolve(root, "site");
    const target = resolve(site, relative);
    if (target !== site && !target.startsWith(`${site}${sep}`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    try {
      const content = await readFile(target);
      response.writeHead(200, {
        "content-type": MIME[extname(target)] ?? "application/octet-stream",
      });
      response.end(content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (relative === "index.html" && (code === "ENOENT" || code === "EISDIR")) {
        try {
          const legacy = await readFile(resolve(site, "index.md"));
          response.writeHead(200, {
            "content-type": MIME[".md"] ?? "text/markdown; charset=utf-8",
          });
          response.end(legacy);
          return;
        } catch {}
      }
      if (code === "ENOENT" || code === "EISDIR") {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(500);
      response.end("internal error");
    }
  };
}

export async function serve(root: string, port: number): Promise<void> {
  const handler = createHandler(root);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  process.stdout.write(`serving ${resolve(root, "site")} on http://127.0.0.1:${port}\n`);
}
