# Blog Translate

[中文](#中文)

Crawl public engineering blogs, translate articles into any target language with
a local OpenAI-compatible model, align sentences, review by hand, and publish a
static side-by-side reader. Sources, target languages, and the model endpoint
are configuration — no machine-specific settings or collected article data live
in this repository.

This repository contains the tooling behind
[AIEngblogx](https://github.com/AIEngblogx/ai-engineering-related-blogs), a
static bilingual reading site. The generated pages are published from that
separate repository.

## Features

- Discovery from listing pages, RSS/Atom feeds, and sitemaps, with
  `robots.txt` checks and request throttling enabled by default.
- Original text, links, and images (including alt text) are preserved.
- Translation into any language tag (`zh-CN`, `ja-JP`, `fr-FR`, …) through an
  OpenAI-compatible chat endpoint. Paragraphs are translated individually so
  source and target stay one-to-one.
- Sentence alignment, mandatory human review, and a self-contained HTML reader.
- Runtime data stays on your machine; the repository contains code,
  configuration, and tests only.

## Requirements

- Node.js 24+
- An OpenAI-compatible chat endpoint (for example Ollama or llama.cpp)

## Quick start

```bash
npm ci
npm run check
npm test
npm run build
node dist/main.js status --json
```

## Configuration

`config.toml` defines sources, crawl limits, `target_languages`, and sampling
parameters. Model names and endpoints are supplied at runtime:

```bash
export OLLAMA_BASE_URL=http://localhost:11434/v1
export OLLAMA_MODEL=<your-model>
node dist/main.js translate --lang zh-CN --json
```

`--model` and `--endpoint` override the environment. `BLOG_TRANSLATOR`,
`BLOG_REVIEWER`, and `BLOG_WEBHOOK_URL` are optional.
`config/glossary.json` holds terminology rules injected into translation prompts.

## Commands

| Command | Purpose |
|---|---|
| `crawl` | Discover and store articles |
| `translate` | Translate pending articles into the configured language(s) |
| `align` | Build sentence-level alignment |
| `review` | Inspect and edit translations |
| `build-viewer` | Generate the side-by-side reader |
| `publish` | Render the static site and record published articles |
| `serve` | Preview the generated site locally |
| `status` | Show state counts |

Every command accepts `--json`; exit code `0` means success, `1` partial
failure, `2` fatal error. State moves through
`pending → translated → aligned → reviewed → published`. Publishing requires a
human-edited, reviewed article.

## Site generation

`scripts/export-site.mjs` renders the published pages from local crawl data:

```bash
npm run build
node dist/main.js crawl --json
node dist/main.js translate --model <model> --lang zh-CN --json
node scripts/translate-titles.mjs <model>
npm run export:site -- ../ai-engineering-related-blogs https://aiengblogx.github.io/ai-engineering-related-blogs
```

The second argument sets the absolute links in RSS; omit it and feed items point
to the original articles. Crawl data is not versioned, so a fresh clone needs
its own `crawl` and `translate` runs. Only articles with a completed translation
are exported. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full sequence.

## Runtime data

`data/`, `inbox/`, `site/`, `logs/`, and `docs/` are local and gitignored.
`config/glossary.json` is the versioned terminology file. Build and publish
write only to these local directories.

## Development

`npm run check` runs TypeScript and Biome, `npm test` uses local HTTP fixtures
only, and `npm run build` emits `dist/`. CI runs the same checks on every push.
Conventions and the site reproduction steps are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Legal

Only public article text is collected, with attribution and links to the
original. Article text, translations, and images remain the property of their
authors; the published site states its own content notice and takedown process.
Translations are provided as-is; consult the original for authoritative wording.
Respect each site's `robots.txt` and terms of use.

## License

MIT, see [LICENSE](LICENSE).

---

## 中文

[English](#blog-translate)

Blog Translate 抓取公开工程博客，用本地 OpenAI 兼容模型把文章翻译成任意目标语言，
做句子对齐、人工校对，最后生成对照阅读的静态站点。来源、目标语言和模型端点都可配置，
仓库里不包含任何特定机器的设置或抓取到的文章数据。

本仓库是 [AIEngblogx](https://github.com/AIEngblogx/ai-engineering-related-blogs)
双语阅读站的工具代码，生成的页面在另一个仓库发布。

- 支持列表页、RSS/Atom、sitemap 发现，默认校验 `robots.txt` 并限速。
- 保留原文、原文链接与配图（含 alt）；按段落翻译，保证源文与译文一一对应。
- 目标语言用语言标签指定，例如 `zh-CN`、`ja-JP`、`fr-FR`。
- 人工校对是发布前不可跳过的关卡，阅读器是单文件 HTML，样式与数据全部内联。

环境要求 Node.js 24+ 和一个 OpenAI 兼容的翻译端点。配置见 `config.toml`，
模型名与端点通过 `--model` / `--endpoint` 或环境变量在运行时提供。

```bash
npm ci && npm run check && npm test && npm run build
node dist/main.js crawl --json
node dist/main.js translate --lang zh-CN --json
node dist/main.js align --json
node dist/main.js review --status aligned
node dist/main.js build-viewer --json
node dist/main.js publish --json
node dist/main.js serve --port 8080
```

## 生成站点

`scripts/export-site.mjs` 从本机抓取数据生成站点页面：

```bash
npm run build
node dist/main.js crawl --json
node dist/main.js translate --model <model> --lang zh-CN --json
node scripts/translate-titles.mjs <model>
npm run export:site -- ../ai-engineering-related-blogs https://aiengblogx.github.io/ai-engineering-related-blogs
```

第二个参数用于生成 RSS 的绝对链接；省略时订阅条目指向文章原文。抓取数据不入库，
新 clone 需要自己跑 `crawl` 与 `translate`。只有已完成译文的文章会被导出，
完整步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

`data/`、`inbox/`、`site/`、`logs/`、`docs/` 都是本机产物，不入库；
`config/glossary.json` 是随仓库维护的术语表。构建与发布只写这些目录，不改动仓库内容。

改动约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，许可为 MIT，见 [LICENSE](LICENSE)。
