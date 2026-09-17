# Agent Office

長期使用的多專案 AI Agent 管理工作區。Pixel Office UI 保留作為 Agent 狀態與工作情況的視覺化介面。

## 現況

目前處於架構設計階段。Milestone 0（Repository Audit）與 Milestone 1 的架構設計已完成，**尚未開始實作**。

| 文件 | 內容 |
|---|---|
| [`docs/architecture-audit.md`](docs/architecture-audit.md) | Milestone 0 — 對 upstream `pixel-agents-hq/pixel-agents@v1.4.1` 的完整稽核：Agent lifecycle、狀態儲存、HookProvider / AgentEvent 架構、持久化、local vs cloud 邊界、data flow 圖，以及 13 項指定問題的逐項回答 |
| [`docs/architecture-proposal.md`](docs/architecture-proposal.md) | Milestone 1 — 提案架構（Control Plane / Agent Runtime 分離）、完整 data model、目錄結構、storage 抽象、migration strategy、cloud constraints、Milestone 1 檔案清單 |

## 規劃中的 Milestones

| # | 內容 | 狀態 |
|---|---|---|
| 0 | Repository Audit | ✅ 完成 |
| 1 | Domain Model（Project / Agent / Task / Skill） | 設計完成，待確認後實作 |
| 2 | Persistence Layer | 未開始 |
| 3 | Project + Agent Management API | 未開始 |
| 4 | Office UI：Project switcher + Agent Inspector | 未開始 |
| 5 | Task Assignment | 未開始 |
| 6 | Agent Runtime Bridge | 未開始 |
| 7 | Knowledge / Memory | 未開始 |
| 8 | Manager Agent orchestration | 未開始 |

## Upstream

本專案規劃以 [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)（MIT License，author: Pablo de Lucca）作為 base。
採用時將保留原始 MIT LICENSE 與 attribution，並在 `NOTICE` 與 `UPSTREAM.md` 中記錄 fork 來源與上游同步流程。
