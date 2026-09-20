# Agent Office — 進度與待辦

最後更新：2026-09-20 ｜ 基準 commit：`e377594` ｜ 分支：`v1.0`

Agent Office 是控制平面（Control Plane），Claude Code 是執行環境（Runtime）。
本文件記錄目前已完成、已知限制，以及尚未完成的事項。

---

## 1. 完成狀態總覽

| 里程碑               | 內容                                              | Commit    | 狀態       |
| -------------------- | ------------------------------------------------- | --------- | ---------- |
| M0 稽核              | Repository 稽核                                   | `fc585db` | 已凍結     |
| M1 領域模型          | Domain model（provider／storage／UI 獨立）        | `322dda8` | 已凍結     |
| M2 本機持久化        | SQLite + BlobStore                                | `03324ca` | 已凍結     |
| M3 P1 垂直切片       | Project／Agent／Task 可持久化                     | `be60a41` | 已凍結     |
| M3 P2 Agent 設定     | Instructions／Skills／AgentKnowledge              | `a7f4e4a` | 已凍結     |
| M3 P3 Project 工作區 | Project context／ProjectKnowledge／Task workspace | `339cf38` | 已凍結     |
| M4 P1 執行橋接       | Task → Context → Claude Code → Session → Output   | `4b077b1` | 已凍結     |
| M4 P2 人工審查       | Review → Accept ／ Request changes → 續跑         | `a894847` | 已凍結     |
| M5 P1 Agent 檔案化   | Agent 私有檔案 + 安全遷移                         | `f06f77e` | 已凍結     |
| M5 P1.1 生命週期安全 | 遷移後修改／刪除／重啟／還原                      | `9ed0545` | 已凍結     |
| M5 P1.1b 執行隔離    | bubblewrap 沙箱 + control plane 授權              | `cb54945` | 已接受     |
| WSL2 驗收工具        | `npm run verify:wsl2`                             | `b71f7af` | 已接受     |
| Windows 單人版       | 原生啟動入口 + 一次性風險同意                     | `510632c` | **待驗收** |
| Claude Code 發現橋接 | Office ⇄ CC 原生 subagent 互通                    | `e377594` | **待驗收** |

---

## 2. 已實作的能力

### 管理（Office）

- **Agent 全域獨立**：不隸屬任何 Project，可跨 Project 使用；建立／編輯 Agent、Instructions、Skills、AgentKnowledge。
- **Project 工作區**：Project context／settings、ProjectKnowledge（CRUD）、成員管理。
- **Task**：建立／編輯／刪除、指派與取消指派、狀態流轉、相依關係（含自我相依、跨專案、循環的拒絕）、inputs／references、可先建立後指派。
- **關閉重開資料保留**：所有上述資料在重啟後完整保留（已由真實 WebSocket + SQLite 重啟測試覆蓋）。

### 執行（Runtime）

- **Run**：Task → 確定性 context 組裝 → Claude Code（`claude -p --output-format json`）→ AgentSession → Output → `review`。
- **Review**：`Accept`（→ `done`，不呼叫 Claude）或 `Request changes`（需非空 feedback）。
- **Revision**：以 `claude -p --resume` 續用同一個 Claude session，只送 feedback；每次成功產生**新的** Output，不覆蓋舊的；feedback 進 Task 歷史。
- **改派 Agent**：不繼承前一個 Agent 的 session，另開新 session。
- 一次只跑一個 Task（V1 限制，刻意保留）。

### Claude Code 發現橋接（`e8cc9ca`…`e377594`）

> 此段由另一個 session 實作，我未逐行重新稽核；內容依 commit 訊息與各模組
> 檔頭說明整理，細節以程式與其測試為準（`storage/__tests__/ccBridge.test.ts`、
> `linkNativeAgent.test.ts`）。

- **Office → CC**：已檔案化的 Agent 會產生 `discovery/agent.md`（含 front
  matter）、`office.json` 與 knowledge 索引，讓 Claude Code 能直接找到該
  Agent；每次異動即同步，不是只在啟動時做一次。
- **CC → Office**：可把 Claude Code 既有的原生 subagent 檔案登記成 Office
  Agent，派工時以 `--agent` 指定。CC 的檔案是**唯一來源**，Office 不回寫、
  不複製其內容，也不將其轉為 file-backed。重複登記同一路徑是「重新讀取」而非
  再建一個 Agent。
- **安全檢查**：檔案含未解決的 git conflict marker 或 Claude Code 無法唯一
  定位時，拒絕登記與派工，而非猜測。
- 個別資源連結失敗會被隔離，不會拖垮整個同步。

### 資料邊界

- Project／Task／Output／review feedback **永不**自動變成 Agent 永久知識；沒有任何一條程式路徑會做這件事。
- Agent 私有資料（Instructions／Skills／AgentKnowledge）以**不可變 ID** 為路徑鍵，存在各自目錄；改名不搬檔。
- 所有 agent-scoped API 一律帶 owner `agentId`，借用他人 resource ID 找不到東西；非 canonical UUID 的路徑一律拒絕。

### 隔離與授權

- **Office control plane 需授權**：所有讀寫訊息與 ready handshake 都要 server token；未授權連線只拿到 `officeError`。
- **Linux／WSL2**：每次 run 在 bubblewrap namespace 內執行（`agents/`、`~/.pixel-agents`、`~/.claude`、`/mnt`、`/init`、`/run/WSL` 皆不掛載），沙箱不可用即**拒絕派工**，無靜默降級。
- **Windows**：無等價 namespace，改為**一次性明確同意**（記錄當時風險全文），未同意前拒絕派工。
- Claude 自身 file-tool deny rules 保留為第二層（非 sandbox）。

### 資料與備份

```
~/.agent-office/
  agent-office.db   Projects / Tasks / Sessions / Outputs / Review notes / 遷移狀態
  agents/           每個 Agent 的 instructions.md、skills/、knowledge/
  blobs/            ProjectKnowledge 與 Output 內容
  runtime/          每 Agent 每 Task 的 config/ 與 work/（暫存，不需備份）
```

備份＝停止 Office 後，把 `agent-office.db`、`blobs/`、`agents/` **三者一起**複製。
詳見 [backup-and-restore.md](backup-and-restore.md)。

---

## 3. 測試現況

| 類型                                                   | 結果                                |
| ------------------------------------------------------ | ----------------------------------- |
| 全套 `npm test`                                        | 646 passed ／ 1 failed ／ 1 skipped |
| `npm run verify:wsl2`（本開發 Linux）                  | 12 pass ／ 0 fail ／ 2 skip         |
| check-types／lint／format／build／knip／asyncapi drift | 全部乾淨                            |

- **1 failed**：`server/__tests__/claudeHookInstaller.test.ts > rejects when the .claude directory is not writable` — 開發容器以 root 執行，`chmod` 擋不住 root，在未修改的 tree 上同樣失敗。**非本專案程式問題，未為此改動 production code。**
- **1 skipped**：真實 Claude 付費 smoke（opt-in，需 `AGENT_OFFICE_CLAUDE_SMOKE=1` + 沙箱 + token）。

---

## 4. 待完成事項

### A. Windows 使用驗收（最高優先，阻塞「可用」）

尚未在任何 Windows 主機執行過。需驗證：

0. Claude Code 發現橋接的實際互通（Office 產生的 `discovery/agent.md` 能被 CC
   讀到；CC 原生 subagent 能登記並以 `--agent` 派工）——此段尚未在任何真實
   主機驗證。
1. `agent-office.cmd` 能啟動、首次同意流程正常、印出的網址可開啟 UI。
2. 以 `cmd.exe` 啟動 `claude.cmd` 子程序（參數由我們加引號後 verbatim 傳入，其中一個是 JSON）。
3. deny rules 的 Windows 路徑形式（反斜線已正規化，但 Claude Code 在 Windows 的規則語法未證實）。
4. 完整流程：建 Agent → 建 Project／Task → Run → Review → Request changes → Accept → 重開仍在。

失敗時回報錯誤原文即可，只修該點。

### B. WSL2 驗收（若要用 WSL2）

執行 `npm run verify:wsl2`（免費、不裝套件、不用 sudo）。需驗證：

1. `bwrap` 存在且 unprivileged user namespace 未被政策擋（Ubuntu 24.04 的 `kernel.apparmor_restrict_unprivileged_userns=1` 會拒絕）。
2. namespace 行為（agents 不可見／專案唯讀／work 可寫／環境不繼承／process 隔離）。
3. `/mnt/c` 專案的掛載方式與效能。
4. **真實** Windows interop 嘗試（執行 `cmd.exe` 副本，非僅檢查 `/init` 不存在）。

若 `bwrap` 未安裝，需先決定是否安裝（需 sudo，未經同意不會執行）。

### C. 一次最小付費驗收（待同意）

同一 Task 首次執行 + 一次 revision，驗證：真實認證、`--resume` 續跑、兩份 Output 與 feedback 保存。
目前**未執行**，等明確同意才做。

### D. 已知限制（非缺陷，已記錄於 ADR 008）

| 項目                       | 狀態                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| 網路未隔離                 | 沙箱內可連外，掛入的專案內容與憑證理論上可外傳；加 netns 會切斷 API |
| 憑證對執行中程序可見       | 程序必須認證；可自行將 token 寫到可寫之處，未宣稱能阻止             |
| abstract unix socket       | 屬 network namespace，主機 socket 仍可達；Office 以授權閘門保護     |
| Windows 無 OS 級隔離       | 以一次性同意取代；shell 指令以使用者權限執行                        |
| Windows 上 transcript 共用 | shell 模式沿用使用者自己的 `~/.claude`，各 run 不分開               |

若要繼續做 OS 層隔離（容器／獨立系統使用者／平台 sandbox），需先決定平台與部署方式。

### E. 明確不做（本階段範圍外）

MCP Memory Provider、RAG／embeddings／語意搜尋、自動記憶、多 Agent 編排、Manager Agent、自動任務拆解、自動指派、平行執行、Agent 間訊息、背景常駐 Agent、雲端、多使用者、認證系統、pixel office 閒置角色、HTML／Figma 專屬輸出流程、UI 重新設計。

---

## 5. 決策紀錄（ADR）

| #                                                       | 決策                                                     |
| ------------------------------------------------------- | -------------------------------------------------------- |
| [001](adr/001-project-aggregate-boundary.md)            | Project 不內嵌 agents／tasks／knowledge／outputs         |
| [002](adr/002-agent-definition-session-separation.md)   | AgentDefinition、AgentSession、Task 是三件事             |
| [003](adr/003-control-plane-runtime-separation.md)      | Control Plane 與 Runtime 分離，可不同機器                |
| [004](adr/004-provider-independent-domain.md)           | Domain 不依賴 provider／storage／UI                      |
| [005](adr/005-global-agents-and-knowledge-ownership.md) | Agent 全域；知識所有權嚴格分離                           |
| [006](adr/006-sqlite-local-persistence.md)              | SQLite 為本機正式儲存                                    |
| [007](adr/007-agent-file-storage.md)                    | Agent 設定存於各自檔案，以 agent id 為鍵                 |
| [008](adr/008-run-sandbox.md)                           | Claude 執行於 bubblewrap namespace；control plane 需授權 |

## 6. 相關文件

- [Windows 快速開始](windows-quickstart.md) — 三步設定與日常使用
- [備份與還原](backup-and-restore.md) — 含 legacy 資料只能還原到遷移當時的限制
- [ADR 008](adr/008-run-sandbox.md) — 隔離的三個層級與各自強度
