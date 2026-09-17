# Architecture Audit — Milestone 0

**稽核對象**：[`pixel-agents-hq/pixel-agents`](https://github.com/pixel-agents-hq/pixel-agents)
**版本**：`v1.4.1`，commit `3537e14`（main HEAD，2026-09 clone）
**授權**：MIT（upstream 保留 `LICENSE`，本專案若採用須保留原作者 attribution）
**稽核方式**：完整 clone + 逐檔閱讀 `core/`、`server/`、`adapters/vscode/`、`webview-ui/`、`CLAUDE.md`、`CONTEXT.md`、`core/asyncapi.yaml`，並實際執行 `npm install / check-types / lint / test`。

> 本文件只描述**現況**，不含任何提案。提案在 `docs/architecture-proposal.md`。

---

## 0. TL;DR

Pixel Agents 是一個**觀測層（observability plane）**，不是 agent 執行框架。

它做的事是：監聽 Claude Code 自己產生的 hook 事件與 transcript 檔案 → 正規化成 `AgentEvent` → 更新記憶體中的 `AgentStateStore` → 透過 WebSocket / postMessage 廣播 → React + Canvas 2D 把每個 session 畫成一個會走路打字的像素角色。

它**沒有**做的事：沒有 Project 概念、沒有 Task 概念、沒有持久化的 Agent 角色定義、沒有 database、沒有 MCP server、沒有任何「從 UI 送工作給 agent」的下行通道。

因此本專案要的「多專案 AI Agent 管理工作區」，**Control Plane 幾乎要全新建立**；但 Office UI、事件正規化、transport、asset pipeline 這四塊可以幾乎原封不動沿用，價值很高。

---

## 1. 現有 Agent lifecycle 如何運作

`CONTEXT.md` 是 upstream 的權威詞彙表，其定義如下（原文語意，非本專案語意）：

- **Agent** = 一個「被追蹤的 AI coding session」。不是一個角色、不是一個員工。
- **Launch** = 從 office 啟動一個新 agent。
- **Adopt** = 開始追蹤一個在 office 外面啟動的 session。
- **Dismiss** = 使用者手動把 agent 從 office 移除。
- **Orphaned** = transcript 檔案被刪除，session 不存在了，office 自動移除。

生命週期實際路徑：

### 建立（兩條路，互斥）

**A. Launch（只有 VS Code 有）**

```
BottomToolbar「+ Agent」
  → ClientMessage { type: 'launchAgent', folderPath?, bypassPermissions? }
  → adapters/vscode/PixelAgentsViewProvider.ts:420
  → adapters/vscode/agentManager.ts:61  vscode.window.createTerminal(...)
  → claudeProvider.buildLaunchCommand(sessionId, cwd)  →  `claude --session-id <uuid>`
  → terminal.sendText(...)
```

`launchAgent` 在整個 repo 只有 **VS Code adapter** 有 handler（grep 驗證）。**standalone CLI 沒有實作**，README 也明說「Standalone does not launch Claude for you」。

**B. Adopt（兩條來源）**

1. Hooks 模式：`~/.claude/settings.json` 內被安裝的 hook script → `POST /api/hooks/claude`（Bearer 驗證）→ `HookProvider.normalizeHookEvent()` → `sessionStart` 事件 → `AgentRuntime` 的 `onExternalSessionDetected`。
2. Heuristic 模式（fallback）：掃描 `~/.claude/projects/<project-hash>/*.jsonl`，1 秒 project scan / 3 秒 external scan。

### 移除

`AgentRuntime.removeAgent(id)` — 關掉 file watcher、清 4 種 timer、通知 adapter、從 store 刪除、`persist()`。觸發來源：`SessionEnd` hook、使用者 dismiss、transcript 被刪（30 秒 stale check）、team 解散、lead 關閉時連帶移除 teammates。

### 關鍵限制

- Agent id 是 **`number`**，由 `store.nextAgentId` 單調遞增，**per-adapter、非全域唯一、重啟後由 persisted 最大值續接**。不是 UUID，不是穩定身分。
- Sub-agent 用**負數 id**（-1 往下），**完全不持久化**，只存在於 webview。
- Agent 的「真實身分」其實是 Claude 的 `session_id`（UUID）與 transcript 檔案路徑；Pixel Agents 只是映射它。

---

## 2. Agent 是由什麼建立

`AgentState` 這個物件字面上在三個地方被 new 出來：

| 位置 | 情境 |
|---|---|
| `server/src/fileWatcher.ts` | 掃描發現新 transcript、adopt 外部 session、發現 teammate / background spawn |
| `server/src/hookEventHandler.ts` | hook 送來的 `sessionStart` |
| `server/src/agentRuntime.ts:restoreExternalAgents()` | 重啟後從 `~/.pixel-agents/<ns>-state.json` 還原 |

建立後一律 `store.set(id, agent)`，`AgentStateStore` 發出 `agentAdded` 事件，broadcast 層翻成 `agentCreated` ServerMessage。

**沒有任何地方是「使用者定義一個 agent 然後它被建立」**。Agent 只能因為「有一個 Claude session 存在」而存在。

---

## 3. Agent state 儲存在哪

三層，且三層的內容差距很大：

### (a) Live state — 記憶體

`server/src/agentStateStore.ts` 內的 `private readonly agents = new Map<number, AgentState>()`。
`AgentState`（`server/src/types.ts`，117 行）包含：tool id/name/status 的 Set 與 Map、`isWaiting`、`permissionSent`、`hadToolsInTurn`、`fileOffset`、`lineBuffer`、`contextTokens` / `maxContextTokens`、team 欄位、`hookDelivered`…

**這一層是 process-local，程序結束即消失。**

### (b) Persisted state — JSON 檔

`PersistedAgent`（`core/src/schemas.ts`）只存這些欄位：

```ts
id, sessionId?, terminalName, isExternal?, jsonlFile, projectDir, folderName?,
teamName?, agentName?, isTeamLead?, leadAgentId?, teamUsesTmux?,
backgroundAgentToolIds?, palette?, hueShift?
```

寫入 `~/.pixel-agents/vscode-state.json` 或 `standalone-state.json`，經由 `FileStateAdapter`（`server/src/fileStateAdapter.ts`），atomic tmp + rename。

**注意這裡面沒有：status、當前工作、歷史、任何產出、任何角色資訊。** 存的幾乎只是「怎麼重新找到那個 transcript 檔案」+ 「這個角色長什麼顏色」。

### (c) 真正的事實來源 — Claude 自己的檔案

`~/.claude/projects/<hash>/<session-id>.jsonl`（transcript）、`~/.claude/teams/<team>/config.json`（team registry）。
Pixel Agents **唯讀**這些檔案，不擁有它們。

---

## 4. 是否已有 persistent agent / team 概念

**部分有，但不是我們要的那種。**

有的：`Team` / `Lead` / `Teammate` 三個概念，以及 `core/src/teamProvider.ts` 這個 100 行的介面（`discoverTeammates`、`getTeamMembers`、`getTeamMetadataForSession`…）。Teammate 有名字（`agentName`）、有自己的 transcript、有自己的座位，並且會被持久化到 `PersistedAgent`。

**但是**：

- Team 的 source of truth 是 **Claude 的** `~/.claude/teams/<teamName>/config.json`。`TeamProvider.getTeamMembers()` 讀它，`isActive: false` 的成員會被移除。Pixel Agents 只是**鏡射**，不擁有生命週期。
- Teammate **沒有** role、systemPrompt、model、skills、tools、memory 這些欄位。它只有 `teamName` + `agentName` + `leadAgentId`。
- Teammate 的存在依賴 lead session 活著；lead `SessionEnd` → `removeTeammates(leadId)` 全部清掉。
- `CONTEXT.md` 明講 Sub-agent「exists only for the duration of its task」。

結論：upstream 的 team 是**執行期的拓樸鏡射**，不是我們要的「可長期存在的員工定義」。Definition/Runtime 的分離在 upstream **完全不存在**。

---

## 5. MCP server / HookProvider / AgentEvent 的架構

### MCP server：**不存在**

全 repo grep `mcp`，只有兩處命中，都是 transcript 記錄型別 `mcp_progress` 的註解（`server/src/transcriptParser.ts:554,558`）。**沒有任何 MCP server、MCP client、MCP tool 定義。**

### HookProvider — 整合邊界（`core/src/provider.ts`, 151 行）

```ts
interface HookProvider {
  kind: 'hook'; id: string; displayName: string; protocolVersion: number;
  normalizeHookEvent(raw) → { sessionId, event: AgentEvent } | null;   // 唯一 CLI-specific 的正規化點
  installHooks(serverUrl, authToken) / uninstallHooks() / areHooksInstalled()
  consentDisclosure() → { headline, disclosure }
  formatToolStatus(toolName, input) → string
  permissionExemptTools / subagentToolNames / readingTools: ReadonlySet<string>
  contextWindowForModel?(model) → number | undefined
  // 可選 file fallback：
  getSessionDirs? / getAllSessionRoots? / sessionFilePattern? / parseTranscriptLine?
  buildLaunchCommand?(sessionId, cwd, opts) → { command, args, env? }
  team?: TeamProvider
}
```

唯一實作：`server/src/providers/hook/claude/claude.ts`（319 行）。註冊表在 `server/src/providers/index.ts`。
架構上確實做到「新增一個 CLI = 新增一個子目錄」，這點是真的，設計品質高。

### AgentEvent — 正規化事件（10 個 variant）

```
toolStart | toolEnd | turnEnd | subagentStart | subagentEnd | subagentTurnEnd
| progress | permissionRequest | sessionStart | sessionEnd
```

**關鍵發現：`AgentEvent` 是純觀測的，方向是單向 CLI → Pixel Agents。**
整個 union 裡沒有任何「指派工作」「送 prompt」「取得產出」的語意。這不是疏漏，是設計定位。

---

## 6. Office UI 如何取得 Agent state

```
AgentStateStore.broadcast(msg)
  → StoreEvents('broadcast')
  → httpServer.ts 的 WS pipe  /  VS Code 的 webview.postMessage
  → webview-ui/src/transport/{webSocketTransport,postMessageTransport}.ts   (MessageTransport 介面)
  → webview-ui/src/hooks/useExtensionMessages.ts   (~30 個 msg.type 分支)
  → 直接 mutate OfficeState（命令式 class，不是 React state）
  → gameLoop.ts (rAF)  →  renderer.ts  →  Canvas 2D
```

協定定義在 `core/asyncapi.yaml`（AsyncAPI 3.0），用 Modelina codegen 成 `core/src/messages.ts`。
**`core/src/messages.ts` 檔頭寫明 `DO NOT EDIT MANUALLY`，必須改 YAML 再 `npm run asyncapi:generate`，CI 有 drift check。**

目前 27 個 `ServerMessage` + 18 個 `ClientMessage`。

**狀態表達力極窄**：wire 上的 agent 狀態只有

```ts
type AgentActivityStatus = 'active' | 'waiting';   // + awaitingInput?: boolean
```

加上 `agentToolPermission` / `agentToolPermissionClear` 兩個 bubble 訊息。
Character FSM 也只有三態：`idle | walk | type`（`webview-ui/src/office/types.ts`）。

18 個 `ClientMessage` 全部是 UI / 設定 / layout 類：`launchAgent`、`focusAgent`、`closeAgent`、`saveLayout`、`saveAgentSeats`、`setSoundEnabled`、`setHooksEnabled`、`saveAreaMappings`… **沒有一個是對 agent 下指令。**

### 一個可直接沿用的機制：Areas

`OfficeState.findFreeSeat(folderName)` 是兩階段的：

1. 先查 `areaMappings[folderName]` → 拿到 area labels → 只在那些 area 的 tile 上找空位。
2. 找不到才退回全域找空位。

`areaMappings: Record<folderName, string[]>` 存在 `config.json` 的 `standalone.areaMappings`。
**這等於 upstream 已經有一個「把一組 agent 視覺上圈在一起」的 primitive**，Project 概念可以直接坐上去。

---

## 7. Layout persistence 如何實作

`server/src/layoutPersistence.ts`（191 行）：

- 檔案：`~/.pixel-agents/layout.json`，**全機器唯一一份，VS Code 與 standalone 共用**。
- 寫入：`JSON.stringify` → 寫 `.tmp` → `fs.renameSync`（atomic）。
- 跨視窗同步：`fs.watch` + 2 秒 polling 混合；`markOwnWrite()` 避免自己寫的被自己讀回。
- 版本：`layout.version` + `layoutRevision`。當 bundled default 的 revision 比使用者檔案新，**直接覆蓋使用者 layout** 並回報 `wasReset: true`。
- `OfficeLayout` 結構：`cols/rows/tiles[]/furniture[]/tileColors[]/pets[]/carpetTiles[]/areas[]/areaTiles[]`，最大 64×64。

**限制：layout 是 machine-global 的單一檔案，沒有 per-project / per-workspace 的 layout。** 多 Project 若要各自一間辦公室，這裡必須改。

---

## 8. standalone / web / Electron / VS Code extension 的差異

| | VS Code extension | Standalone CLI |
|---|---|---|
| 入口 | `adapters/vscode/extension.ts` | `server/src/cli.ts`（`npx pixel-agents`） |
| Transport | `PostMessageTransport`（永遠 connected） | `WebSocketTransport`（`/ws`，指數退避重連） |
| SPA 來源 | webview 內嵌 | Fastify `@fastify/static` 服務 `dist/webview/` |
| 持久化 namespace | `vscode` | `standalone` |
| **啟動 agent** | ✅ `createTerminal` + `sendText` | ❌ **沒有實作** |
| **focus agent** | ✅ `terminal.show()` | ❌ 無 terminal 概念 |
| 埠 | ephemeral（embedded） | ephemeral 或 `--port` |
| `/ws` 連線閘門 | Bearer token | same-origin 檢查 |
| 特權訊息閘門 | Bearer token | URL `?token=` |
| 共用 | `~/.pixel-agents/layout.json`、`config.json`、hook fan-out registry | 同左 |

**Electron：repo 內不存在。** `CONTEXT.md` 只把「a macOS app」當成未來可能的 adapter 舉例。

**README 與程式碼不一致（實測發現）**：README 第 115 行寫 `Pass --no-terminal to disable the embedded terminal`，但 `server/src/cli.ts:parseArgs` 只處理 `--port` / `-p` / `--host` / `--help`。v1.4.1 的 CLI **沒有 embedded terminal，也沒有 `--no-terminal`**。README 領先程式碼。

---

## 9. 哪些功能只能 local 使用

全部與「使用者 home 目錄」或「本機程序」綁死的部分：

| 功能 | 綁死的東西 |
|---|---|
| Hooks 安裝 | 寫 `~/.claude/settings.json`（`claudeHookInstaller.ts`，749 行，含 consent gate、備份、驗證） |
| Heuristic 偵測 | 掃描 `~/.claude/projects/**/*.jsonl` |
| Team 成員查詢 | 讀 `~/.claude/teams/<team>/config.json` |
| Server 探索 / hook fan-out | `~/.pixel-agents/servers/<pid>-<port>.json`，用 `process.kill(pid, 0)` 判活 |
| 所有持久化 | `~/.pixel-agents/*.json` |
| 啟動 / focus agent | VS Code terminal API |
| 外部素材目錄 | 本機絕對路徑 |
| 預設繫結 | `127.0.0.1`；token 直接印在 CLI 輸出的 URL 裡 |

---

## 10. 哪些部分可以部署到 cloud

**已經是網路形狀、可直接上雲的：**

- `core/asyncapi.yaml` + 產生的 `messages.ts` — 純協定，與傳輸無關。
- `webview-ui/` 整包 — 只依賴 `core/`，經由 `MessageTransport` 介面說話，換成遠端 WSS 不需改任何 UI 程式。
- `server/src/httpServer.ts` — Fastify，`POST /api/hooks/:providerId` 本來就是 HTTP + Bearer 的 ingress，天生適合讓遠端 runtime 回報。
- `AgentStateStore` / `HookEventHandler` / `HookProvider.normalizeHookEvent` — 純資料轉換，無 I/O 假設。
- Asset pipeline（PNG → SpriteData）— 隨 server bundle 出貨即可。

**不能上雲、必須留在 runtime 主機那一側的：**

- `FileStateAdapter` / `layoutPersistence` / `configPersistence`（要換成 repository 抽象）
- `fileWatcher` / `transcriptParser`（heuristic 模式在雲端根本無檔案可讀）
- `claudeHookInstaller`、server registry、terminal 啟動

**雲端化的三個硬性阻礙（現況）：**

1. **沒有使用者身分**。目前的授權模型是「一個 process 啟動時 mint 一個 token，誰有 token 誰就是主人」。單機單人可以，多租戶不行。
2. **WS 沒有 scoping**。`httpServer.ts` 的 `/ws` 對每一條連線都掛上 `store.on('broadcast')`，也就是**每個 client 收到所有 agent 的所有事件**。多專案/多租戶必須在 server 端做過濾。
3. **沒有持久層**。見下一節。

---

## 11. repository 目前是否已有 database

**沒有。完全沒有。**

- `package.json` dependencies 只有 4 個：`@fastify/cors`、`@fastify/static`、`@fastify/websocket`、`fastify`。
- 全 repo grep `sqlite|postgres|prisma|drizzle|knex|mongodb|supabase` → **0 命中**（排除 lockfile）。
- 所有持久化都是 `fs.writeFileSync` 寫 JSON + `renameSync`。
- 沒有 migration、沒有 schema 版本管理（除了 `layout.version` / `layoutRevision` 這種 ad-hoc 欄位）。

---

## 12. Agent 關閉 / container restart 後哪些資料會消失

### 同一台機器、home 目錄還在時

**保留**：`layout.json`（辦公室外觀、家具、areas、pets）、`config.json`（設定、`areaMappings`、hooks consent）、每個 namespace 的 `agents` 與 `seats`（座位、palette、hueShift）。

**消失**：

- 所有 live 活動狀態：`activeToolIds`、`activeToolStatuses`、`isWaiting`、`hadToolsInTurn`、`contextTokens`/`maxContextTokens`
- **Sub-agent 100% 消失**（`agentStateStore.persist()` 明確 `if (agent.spawnToolUseId) continue;` 跳過）
- background spawn 的子 agent（被視為 derived state，靠 1 秒掃描重新長出來）
- 「這個 agent 剛剛在做什麼」— 沒有任何活動歷史被保存

還原機制只有 `restoreExternalAgents()`：檢查 `jsonlFile` 是否還存在 → 重建一個 `fileOffset` 歸零的 `AgentState` → 重新掛 watcher。**是重新觀測，不是還原狀態。**

### Ephemeral container（本專案的雲端目標場景）

`~/.pixel-agents/` 與 `~/.claude/` 都在容器內 → **100% 資料消失，包含 layout**。
目前沒有任何一個 byte 存在 process 外部的持久儲存。

---

## 13. 現有 Agent 是否真的能執行工作，還是主要只是 visualization layer

**是 visualization layer。** 這是本次稽核最重要的結論。

它**能**做的：

- 在 VS Code terminal 裡跑 `claude --session-id <uuid>`（一行指令，之後就不管了）
- `terminal.show()` 把終端機叫到前面
- 觀測這個 session 在做什麼，並畫出來

它**不能**做的（逐項確認過協定與程式碼）：

| 需求 | 現況 |
|---|---|
| 送一個 prompt / task 給執行中的 agent | ❌ 18 個 ClientMessage 沒有任何一個做這件事 |
| 取得 agent 的結構化產出 | ❌ 只 parse transcript 取「工具名稱」來做動畫，不取內容 |
| 設定 agent 的 system prompt | ❌ 無此概念 |
| 指定 model / provider | ❌ `buildLaunchCommand` 寫死 `claude --session-id <uuid>` |
| 指定 skills / tools | ❌ 無此概念 |
| Agent 之間互相指派工作 | ❌ 無此概念 |
| 知道 agent「完成了什麼」 | ❌ 只知道「turn 結束了」 |

`AgentEvent` 的 10 個 variant 全部是過去式的觀測；`ClientMessage` 的 18 個 variant 全部是 UI 與設定。
**整個系統沒有一條從 UI / server 指向 agent 的控制通道。**

---

## 14. 目前的 Data Flow

```
┌─────────────────────────── 執行層（完全在使用者機器上）────────────────────────────┐
│                                                                                  │
│   VS Code Terminal                     使用者自己的終端機 / tmux                    │
│   `claude --session-id <uuid>`         `claude`                                  │
│          │                                    │                                  │
│          └────────────┬───────────────────────┘                                  │
│                       │                                                          │
│                       ▼                                                          │
│         ~/.claude/settings.json 裡被安裝的 hook script                             │
│         ~/.claude/projects/<hash>/<session>.jsonl  (transcript)                  │
│         ~/.claude/teams/<team>/config.json         (team registry)               │
└───────────────┬──────────────────────────────┬───────────────────────────────────┘
                │ (a) HOOKS 模式               │ (b) HEURISTIC 模式
                │ POST /api/hooks/:providerId  │ fs.watch + 500ms polling
                │ Bearer <token>               │
                ▼                              ▼
      ┌─────────────────────┐        ┌──────────────────────┐
      │ httpServer.ts       │        │ fileWatcher.ts       │
      │ (Fastify)           │        │ transcriptParser.ts  │
      └──────────┬──────────┘        └──────────┬───────────┘
                 │                              │
                 ▼                              │
      ┌──────────────────────────────┐          │
      │ HookProvider                 │          │
      │ .normalizeHookEvent()        │          │
      │ (唯一知道 Claude 細節的地方)   │          │
      └──────────┬───────────────────┘          │
                 │                              │
                 └──────────┬───────────────────┘
                            ▼
                   ╔══════════════════╗
                   ║   AgentEvent     ║   ← 正規化、CLI-agnostic、單向、純觀測
                   ║   (10 variants)  ║
                   ╚════════┬═════════╝
                            ▼
                ┌───────────────────────────┐
                │ HookEventHandler          │
                │ SessionRouter (sid→id)    │
                │ AgentRuntime (timers,     │
                │   scanners, dismissal)    │
                └───────────┬───────────────┘
                            ▼
                ┌───────────────────────────┐        ┌────────────────────────────┐
                │ AgentStateStore           │◄──────►│ FileStateAdapter           │
                │ Map<number, AgentState>   │ persist│ ~/.pixel-agents/           │
                │ (記憶體，唯一真實來源)      │        │   <ns>-state.json          │
                └───────────┬───────────────┘        │   config.json              │
                            │ StoreEvents            │   layout.json              │
                            │ ('broadcast')          └────────────────────────────┘
                            ▼
                ╔═══════════════════════════╗
                ║ ServerMessage × 27        ║  ← core/asyncapi.yaml (單一事實來源)
                ║ ClientMessage × 18        ║     → codegen → core/src/messages.ts
                ╚═══════════╤═══════════════╝
                            │
            ┌───────────────┴────────────────┐
            ▼                                ▼
   PostMessageTransport             WebSocketTransport
   (VS Code webview)                (browser /ws)
            └───────────────┬────────────────┘
                            ▼
                ┌───────────────────────────┐
                │ useExtensionMessages.ts   │  ~30 個 msg.type 分支
                └───────────┬───────────────┘
                            ▼
                ┌───────────────────────────┐
                │ OfficeState (命令式 class) │  characters / seats / pets / layout
                │ characters.ts  FSM        │  idle | walk | type
                │ gameLoop.ts    rAF        │
                │ renderer.ts    Canvas 2D  │
                └───────────────────────────┘

        ⚠️ 注意：整張圖沒有任何一條箭頭是「向下」的。
           UI → server 只有設定與 layout；server → agent 只有一次性的 terminal 啟動。
```

---

## 15. Base 健康度實測

在本容器（Node v22.22.2 / npm 10.9.7）實際執行：

| 指令 | 結果 |
|---|---|
| `npm install` | ✅ exit 0（490 個套件，無 postinstall 問題） |
| `npm run check-types` | ✅ exit 0（`tsc --noEmit` × 2 個 project，0 error） |
| `npm run lint` | ✅ 0 error，1 warning（`App.tsx:214` react-hooks/exhaustive-deps，upstream 既有） |
| `npm test` | ⚠️ 549 passed / 1 failed / 17 skipped，29 個測試檔 |
| `npm run e2e` | 未執行（需 VS Code Electron + 瀏覽器環境，本容器無 GUI） |

唯一失敗的測試是 `server/__tests__/claudeHookInstaller.test.ts:496`（"rejects when the .claude directory is not writable"）。原因是該測試用 `chmod 0o500` 讓目錄不可寫，**但本容器以 root 執行，root 不受檔案權限限制**，所以安裝成功、測試預期的 reject 沒發生。這是**環境假象，不是程式缺陷**；在非 root 環境會通過。

程式碼規模：`core` + `server` + `adapters` 約 13,044 行 TS；`webview-ui` 約 13,490 行 TS/TSX。
測試：29 個 Vitest 檔、550 個測試；另有 Playwright e2e（VS Code + standalone 兩套 fixture，含 mock-claude scenario runner）。
CI：`.github/workflows/ci.yml`，含 AsyncAPI drift check、e2e inventory drift check、custom ESLint rules（`no-inline-colors` / `pixel-shadow` / `pixel-font`，全部 error 級）。

---

## 16. 對本專案目標的落差總表

| 本專案需求 | upstream 現況 | 落差 |
|---|---|---|
| Project domain | 無（最接近的是 `folderName` + `areaMappings`） | 全新建立 |
| Persistent Agent definition | 無（Agent ≡ session） | 全新建立 |
| Definition / Runtime 分離 | 無 | 全新建立 |
| 7 種 agent status | wire 只有 `active` / `waiting` | 需擴充協定 + 狀態解析器 |
| Task domain | 無 | 全新建立 |
| Task assignment（人→agent、agent→agent） | 無下行通道 | 全新建立（最大工程量） |
| Skills | 無 | 全新建立 |
| Knowledge / Memory | 無 | 全新建立 |
| Storage 抽象 | 無（直接 `fs.writeFileSync`） | 全新建立 |
| Database | 無 | 全新建立 |
| Control Plane / Runtime 分離 | 無（單一 process） | 全新建立 |
| Office UI | ✅ 完整、成熟、可直接沿用 | 只需擴充（Project switcher、Inspector） |
| Layout editor | ✅ 完整 | 需支援 per-project layout |
| Provider 抽象（不綁 Claude） | ✅ `HookProvider` 設計良好 | 沿用並擴充「下行」方向 |
| 事件正規化 | ✅ `AgentEvent` | 沿用，新增 control 事件族 |
| Transport 抽象 | ✅ `MessageTransport` | 沿用 |
| 協定單一事實來源 | ✅ AsyncAPI + codegen + CI drift check | 沿用（新訊息必須改 YAML，不可手改 `messages.ts`） |
| Asset / 角色 / 動畫 pipeline | ✅ 完整 | 沿用 |
| 測試基礎建設 | ✅ Vitest + Playwright + mock-claude | 沿用 |
