# CC 活動看板：任務紀錄與常駐人物

取代 Office 自建 Agent／Project／Task／派工的近期目標：**Claude Code（CC）建立與維護
Agent、指派工作；Office 只觀測並顯示。** 沿用既有像素辦公室、人物、動畫與傳輸層，不重建
另一套前端，不刪除既有 Office 管理／派工後端模組（保留但不進入新畫面）。

## 1. 人物來源：CC 原生 Agent 名單

- 伺服器啟動時（`AgentRuntime` 建構時）掃描 `~/.claude/agents/**/*.md`
  （`storage/src/files/nativeAgentDiscovery.ts` 的 `discoverNativeAgents`），
  以 `nativeAgentRoster` 訊息廣播給所有已連線的前端，`webviewReady`／`requestCallLog`
  也會補送一次快照。
- 監看該目錄變化（`server/src/nativeAgentRoster.ts`：`fs.watch` 遞迴監看，失敗時退回
  3 秒輪詢），新增或修改 Agent 檔案後不需重啟、不需 `npm run link-native-agent`、不需
  Office 的 Project 成員流程。
- 前端 `webview-ui/src/office/engine/officeCharacters.ts` 依 `filePath` 建立穩定的
  負數字元 id：同一個檔案永遠對應同一個人物，重新整理／重新掃描不會產生第二個常駐人物。
- 名稱或描述有衝突（同目錄下兩個檔案宣告相同 `name:`）時，該名稱標記
  `ambiguous: true`；有衝突的名稱永遠不會被視為「可信任地對應到某個人物」（見下）。

## 2. 呼叫觀測：目前唯一支援的路徑

**只支援「CC 對話中以 `Task` 工具委派子 Agent（`subagent_type` 參數）」這一種呼叫方式。**

- 觀測點在 `server/src/transcriptParser.ts`：讀到 `Task` 工具的 `tool_use` 區塊時，取
  `subagent_type`（Agent 名稱）、`prompt`（完整任務文字）、`description`（簡短標題）與
  該區塊穩定的 JSONL `tool_use` id；讀到對應的 `tool_result` 時視為呼叫結束
  （`is_error` 決定「已結束」或「失敗」）。
- **不支援**：使用者另外以 `claude --agent <name>` 啟動的獨立會話。目前的 hooks／
  transcript 事件沒有任何欄位會帶出啟動時使用的 `--agent` 名稱，Office
  無法可靠地把這種會話與某個原生 Agent 對應起來，所以刻意不做——寧可不顯示，也不
  用資料夾、視窗標題等會碰撞的線索去猜測身分。這是本輪最大的觀測缺口；如需支援，
  需要 CC 那側在 hook 事件或 transcript 中加入可驗證的欄位（例如把啟動旗標寫進
  `SessionStart` 事件），屬於後續工作。
- 呼叫身分解析（`server/src/callLogBridge.ts` + `nativeAgentRoster.ts`）：`subagent_type`
  只有在「剛好比對到一個非 ambiguous 的名單檔案」時才算「已辨識」
  （`recognized: true`，附上 `agentFilePath`）；否則顯示「未辨識 Agent」，絕不猜測指派
  給任何現有人物（包含 `skill-retriever`）。

## 3. 資料保存：獨立資料表，不與舊 Task 混用

- 新增 SQLite migration 4（`storage/src/sqlite/migrations.ts`）：`agent_calls` 表，欄位
  對應 `parentSessionId`＋`toolUseId`（唯一鍵，用來去重複／晚到事件）、`agentName`、
  `agentFilePath`、`recognized`、`taskText`、`taskDescription`、`status`、`startedAt`、
  `startUnknown`、`endedAt`、`usage_*`。**沒有** `project_id`／`task_id` 外鍵：刻意不
  借用 `tasks`／`agent_sessions`，避免新呼叫歷史與 Office 舊 Task 混為一談，也不用
  虛構 Project／Task 去湊資料。
- Port／實作見 `storage/src/callLog.ts`、`storage/src/sqlite/callLog.ts`，掛在
  `SqliteStorage.callLog`（與 `reviews`／`ReviewNoteStore` 相同「應用層記錄」模式）。
- 舊的 `projects`／`agents`／`tasks`／`agent_sessions` 表與 `OfficeService`／
  `taskRunner.ts` 完全保留，未被刪除或改寫；只是新畫面不再呼叫它們。

## 4. 執行時長／狀態規則

- `startedAt` 是伺服器**觀測到** `tool_use` 的當下時間（transcript 是近乎即時被讀取
  的，未使用 transcript 內部欄位，因為既有程式從未依賴過該欄位的存在與格式）。
  沒有更早的真實開始時間可補時，`startUnknown: true`，前端顯示「開始時間未知」，
  不假裝有完整時長。
- 狀態只有 `running → ended｜failed`，加上重啟安全網的 `unknown`
  （`markOpenCallsUnknown`，見下）。`waiting_response` 保留給以後可能支援、能夠獨立
  暫停等待輸入的呼叫方式；本輪唯一支援的 `Task` 工具呼叫是同步的，永遠不會進入這個
  狀態。
- 重啟／連線中斷：伺服器啟動時，任何仍是 `running`／`waiting_response` 的紀錄一律
  轉為 `unknown`，**不**補上 `endedAt`（不把關閉時刻當作完成時間）。前端對 `unknown`
  顯示「未知（連線中斷）」，不是「已結束」。
- 重複／晚到事件：`start()`／`end()`／`markStatus()` 都以 `(parentSessionId, toolUseId)`
  去重複；已是終態（`ended`／`failed`／`unknown`）的紀錄不會被稍後的事件覆寫或「復活」。
- 同一 Agent 同時多筆呼叫：以個別 `toolUseId` 分開追蹤，其中一筆結束不會把人物或其餘
  呼叫誤判為待命／已結束（見 `webview-ui/test/officeCharacters.test.ts` 的並行測試）。

## 5. Token：可選，本版尚未提供

目前**沒有**顯示任何 Token 數字——不是欄位被隱藏，是本版完全沒有寫入。

原因：`server/src/contextUsage.ts` 現有的 `contextTokens` 是「目前上下文視窗占用量」的
快照（會因壓縮／`/clear` 掉回小數字），使用者已明確要求不可拿它冒充消耗量。要正確算出
「歸屬到單一次呼叫」的用量，需要把該次呼叫時間窗內、且沒有其他並行呼叫互相干擾的
sidechain usage 記錄加總——這件事在有並行呼叫時容易算錯，一旦本輪時間有限，選擇不做，
以免顯示出不可靠但看起來像真的數字。`AgentCallUsage`／`usage_*` 欄位與 UI 顯示邏輯已
就位（`storage/src/callLog.ts`、`TaskLogPanel.tsx`），未來要接上時，只需要在
`callLogBridge.ts` 呼叫 `storage.callLog.setUsage(...)`。

## 6. 前端

- `webview-ui/src/control/TaskLogPanel.tsx`（新）：唯讀清單，取代 `OfficePanel`，欄位為
  呼叫時間／Agent／任務內容（截斷可展開）／狀態／執行時長（執行中即時更新）／結束時間，
  預設最新在前。沒有 Token 欄（見上）。
- `webview-ui/src/control/useTaskLog.ts`（新）：訂閱 `nativeAgentRoster`／
  `agentCallLogSnapshot`／`agentCallUpdated`，送出一次 `requestCallLog`。
- `BottomToolbar.tsx` 的「Office」按鈕改名「任務紀錄」，`App.tsx` 不再掛載
  `OfficePanel`／`ProjectWorkspacePanel`／`AgentConfigPanel`（檔案本身保留，未刪除，
  只是不再被引用）。點擊人物改為開啟任務紀錄面板（原本開啟的是 Office 的 Agent
  設定表單，該表單已不在新流程中）。

## 7. 已知限制與後續

- 只支援 `Task` 工具委派；獨立 `--agent` 會話不可觀測（見第 2 節）。
- 沒有 Token 資料（見第 5 節）。
- Playwright e2e（`e2e/tests/browser/office-characters.spec.ts`）仍模擬舊的
  `officeState`／Project／Task 驅動流程，尚未針對新的 `nativeAgentRoster`／
  `agentCallLogSnapshot` 協定改寫；本輪的隔離驗證改由重寫後的
  `webview-ui/test/officeCharacters.test.ts` 涵蓋（見下方驗證指令）。真實瀏覽器 e2e
  改寫留待後續。
- Skills、知識庫、Agent 的 GitHub 私有同步仍由 CC 那側管理，未變動。

## 8. 回退方式

- 純前端：把 `App.tsx` 的 `<TaskLogPanel .../>` 換回 `<OfficePanel .../>`（該元件與其
  依賴的 `useOfficeState.ts` 未被刪除），`BottomToolbar` 按鈕文字改回即可，不需要還原
  資料庫。
- 後端：`agent_calls` 是新增的獨立資料表（migration 4），未修改任何既有表；不想保留
  觀測資料時，直接 `DROP TABLE agent_calls`（或整個刪除 `~/.agent-office/agent-office.db`
  重新遷移）不會影響 `projects`／`agents`／`tasks`／`agent_sessions` 既有資料。
- 不需要刪除或重置 CC 原生 Agent 檔案（`~/.claude/agents/`）——Office 從未寫入這個目錄。

## 9. 驗證

### 隔離事件測試（已執行，不需要真人 Claude 連線）

```sh
npm run check-types
npm run lint
npm run build:webview
node esbuild.js
npm run test:domain
npm run test:storage
npm run test:webview
npm run test:server
```

新增／改寫的測試：

- `storage/__tests__/nativeAgentDiscovery.test.ts`：roster 掃描、名稱衝突標記。
- `storage/__tests__/callLog.test.ts`：呼叫的建立／去重複／結束／狀態不復活／重啟安全網／
  usage 寫入。
- `webview-ui/test/officeCharacters.test.ts`（改寫）：待命人物、roster 增減不重複、
  呼叫開始／結束切換工作狀態、未辨識呼叫不建立人物、並行呼叫互不影響、快照重置。

`server/__tests__/claudeHookInstaller.test.ts` 的「目錄不可寫入」一項在以 root 執行測試
的環境下會失敗（root 略過檔案權限檢查），這是執行環境本身的限制，與本輪修改無關，換一般
使用者權限執行即可通過。

`clientMessageHandler.test.ts`／`consentFlow.test.ts`／`configPersistence.test.ts` 原本
只覆寫 `process.env.HOME`：`os.homedir()` 在 Windows 讀的是 `USERPROFILE`，只設
`HOME` 在 Windows 上不會生效，測試會碰到真實的 `~/.pixel-agents`／`~/.claude`。三個
檔案已一併補上 `USERPROFILE` 覆寫與還原；`webviewReady` 現在一律會讀取 Office 資料庫
（任務紀錄快照），連帶修正兩處測試在多個案例間共用同一個（可能已被刪除的）暫存目錄
導致的 SQLite 「disk I/O error」（`clientMessageHandler.test.ts` 的兩個 describe block、
`consentFlow.test.ts`、`httpServerWs.test.ts` 的兩個 describe block、`officeAuthorization.test.ts`
新增讀 native-agent roster 時的暫存目錄隔離）。

### Windows 真人驗收（需另行確認任務內容，會消耗模型額度）

```powershell
npm.cmd ci
npm.cmd run build
node .\dist\cli.js
```

1. 開啟輸出的網址；`~/.claude/agents/skill-retriever.md` 存在時，重新整理即可看到
   「待命」的 skill-retriever 人物，不需要建立 Project 或 Office Task。
2. 在一個一般 Claude Code 對話中，以 `Task` 工具委派 `subagent_type: skill-retriever`
   並給出真實任務文字。
3. 確認：人物切換「工作中」；「任務紀錄」清單新增一筆，呼叫時間／任務內容與實際相符；
   委派完成後人物回到「待命」，紀錄狀態變「已結束」，執行時長固定；重新整理瀏覽器後
   紀錄仍在。
4. 重覆呼叫同一 Agent 兩次，確認清單有兩筆各自獨立的紀錄，沒有重複人物。

不得以模擬畫面或假事件取代第 2-4 步；Token 目前無資料可驗證（見第 5 節）。
