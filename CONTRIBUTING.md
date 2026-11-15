# Contributing

## 开发环境

Node.js 24+。

```bash
npm ci
npm run check
npm test
npm run build
```

`npm run check` 跑 TypeScript 与 Biome，`npm test` 只使用本地 HTTP fixture，不需要网络或本地模型。CI 对每个 push 和 PR 跑同样的检查。

## 改动约定

- 新逻辑要有测试；CLI 行为变更同步改 README。
- 抓取、翻译、校对、发布的中间产物都落盘，命令保持幂等。
- 模型名与端点只在运行时传入，不写进入库文件。
- `config/glossary.json` 维护术语表。

## 生成站点

站点页面由 `scripts/export-site.mjs` 生成，产物推送到 [ai-engineering-related-blogs](https://github.com/AIEngblogx/ai-engineering-related-blogs)。这条路径与 CLI 的 `publish`（写入本机 `site/`）相互独立。文章数据（`data/`、`inbox/`）不入库，复现需要自己抓取并翻译：

```bash
npm run build
node dist/main.js crawl --json
node dist/main.js translate --lang zh-CN --json
node scripts/translate-titles.mjs <model>
npm run export:site -- <站点目录> https://aiengblogx.github.io/ai-engineering-related-blogs/
```

第二个参数用于生成 RSS 的绝对链接，省略时 RSS 指向文章原文。导出只收录译文完整且正文不少于 3 段的文章，并清理上一版不再收录的页面。

## 译文勘误

译文勘误与下架请求请到[站点仓库 Issue](https://github.com/AIEngblogx/ai-engineering-related-blogs/issues)提交，注明文章与段落。
