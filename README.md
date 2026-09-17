# Agent Office

長期使用的多專案 AI Agent 管理工作區。

Agent Office 在 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) 之上，additive 地加入一個 **Control Plane**：Project、可長期存在的 Agent 角色、Task、Skill 與 Knowledge。Pixel Office UI 保留作為 Agent 狀態與工作情況的視覺化介面。

> **Upstream attribution** — 本專案 fork 自 [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)（MIT License，author: Pablo de Lucca），base 為 `v1.4.1` / `3537e14`。
> 原始 MIT `LICENSE` 完整保留。fork 來源與上游同步流程見 [`NOTICE`](NOTICE) 與 [`UPSTREAM.md`](UPSTREAM.md)。
> upstream 自身的 README 保留在 [其原始 repository](https://github.com/pixel-agents-hq/pixel-agents#readme)。

## 架構

三個平面。既有的 `AgentEvent` 觀測通道（單向，CLI → Control Plane）語意不變；Task 派發走一條全新的下行通道，不塞進 `AgentEvent`。

| 平面 | 職責 | 狀態 |
|---|---|---|
| **Presentation** — `webview-ui/` | Pixel Office 渲染、layout editor、（未來）Project switcher + Agent Inspector | upstream 既有，未改動 |
| **Control Plane** — `domain/` `storage/` `server/src/control/` | 擁有 Project / Agent / Task / Skill / Knowledge / Output | 建置中 |
| **Agent Runtime** — `runtime/` | 真正執行 Claude Code / Codex / 自訂 agent | 介面已定，實作未開始 |

層級規則（擴充 upstream 的分層）：

```
domain/     → 依賴 nothing（provider-independent、storage-independent、UI-independent）
storage/    → domain/
runtime/    → domain/ + core/
core/       → nothing            （upstream 原規則）
server/     → core/ + domain/ + storage/ + runtime/
webview-ui/ → core/ + domain/（僅型別）
adapters/   → core/ + server/
```

## Milestones

| # | 內容 | 狀態 |
|---|---|---|
| 0 | Repository Audit | ✅ 完成 |
| 1 | Domain Model（Project / Agent / AgentSession / Task / Skill / Knowledge / Output）+ in-memory storage | ✅ 完成 |
| 2 | Persistence Layer（file / SQLite） | 未開始 |
| 3 | Project + Agent Management API | 未開始 |
| 4 | Office UI：Project switcher + Agent Inspector | 未開始 |
| 5 | Task Assignment | 未開始 |
| 6 | Agent Runtime Bridge | 未開始 |
| 7 | Knowledge / Memory retrieval | 未開始 |
| 8 | Manager Agent orchestration | 未開始 |

## 文件

| 文件 | 內容 |
|---|---|
| [`docs/architecture-audit.md`](docs/architecture-audit.md) | Milestone 0 — upstream 完整稽核與 data flow |
| [`docs/architecture-proposal.md`](docs/architecture-proposal.md) | 提案架構、data model、migration strategy、cloud constraints |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`UPSTREAM.md`](UPSTREAM.md) | 上游同步流程與衝突面 |
| `CLAUDE.md` / `CONTEXT.md` | upstream 的工程參考與詞彙表（已擴充分層規則） |

## 開發

```bash
npm install
npm run check-types
npm run lint
npm test
npm run build
```

Agent Office 新增的 workspace 可單獨測試：

```bash
npm run test:domain
npm run test:storage
```

其餘開發流程（F5 啟動 Extension Development Host、`node dist/cli.js`、e2e）沿用 upstream，見 `CONTRIBUTING.md` 與 `e2e/README.md`。

## License

MIT — 見 [`LICENSE`](LICENSE)。
