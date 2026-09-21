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

**只支援「CC 對話中委派子 Agent（`subagent_type` 參數）」這一種呼叫方式。**

- 觀測點在 `server/src/transcriptParser.ts`：讀到委派子 Agent 的 `tool_use` 區塊時，取
  `subagent_type`（Agent 名稱）、`prompt`（完整任務文字）、`description`（簡短標題）與
  該區塊穩定的 JSONL `tool_use` id；讀到對應的 `tool_result` 時視為呼叫結束
  （`is_error` 決定「已結束」或「失敗」）。
- **工具名稱同時接受 `Task` 與 `Agent`**：依 `CLAUDE.md` 本身的說明，較舊的 CLI
  版本用 `Task`、目前版本用 `Agent`（同一顆按鈕，不同版本叫不同名字），兩者都會被解析
  （`server/__tests__/callLogCapture.test.ts` 兩者都有測試）。若你實際使用的版本用了
  這兩個名稱以外的第三種名字，清單會靜默漏掉那次呼叫——這是目前唯一已知、且沒有把握
  涵蓋所有版本的風險點；若第一次真人驗收沒看到紀錄，這是第一個要懷疑的地方（可對照你
  本機 transcript 該筆 `tool_use.name` 實際的值）。
- **排除已由既有機制追蹤的 Teammate 產生方式**：`Agent` 工具呼叫若額外帶
  `name` 欄位（新版隱性 Team／`run_in_background` 具名產生的 Teammate），視為既有的
  常駐 Teammate 角色，不重複記成一次「呼叫」——這類會話本來就有自己獨立的持續存在人物，
  不是一次有始有終的委派。**已知殘留角落**：極少數新版「隱性 Team」（Claude 5，背景
  預設啟動、`tool_use` 當下沒有 `name`，要等到 `tool_result` 才帶出
  `agent_id: <name>@<team>`）在起始當下會先被記成一筆呼叫，之後才被既有 Team 機制
  識別為 Teammate；這種情況下清單可能把它標成「已結束」而非正確排除，屬已知但影響
  範圍很小的邊界情況，本輪未特別處理。
- **背景／非同步委派**：某些委派會立刻收到「Async agent launched successfully...」
  這類啟動確認，而不是真正的執行結果——這種委派的真正完成（如果有）發生在另一個
  Office 目前不會讀取的 transcript 裡。遇到這種情況，清單會把狀態標成
  **「背景委派（本版未追蹤結果）」**（`background_not_tracked`），**不會**補上假的
  結束時間或誤判成「已結束」。
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
- 狀態有 `running → ended｜failed｜background_not_tracked`，加上重啟安全網的
  `unknown`（`markOpenCallsUnknown`，見下）。`waiting_response` 保留給以後可能支援、
  能夠獨立暫停等待輸入的呼叫方式；本輪唯一支援的同步委派永遠不會進入這個狀態。
  `background_not_tracked` 與 `unknown` 意義不同且不可互換：前者是「一開始就看出這是
  背景委派，本版本來就不追蹤它的完成」，後者是「本來以為還在追蹤，但伺服器重啟／
  失去連線，不確定它後來怎麼樣了」——兩者都不會補上 `endedAt`。
- 重啟／連線中斷：伺服器啟動時，任何仍是 `running`／`waiting_response` 的紀錄一律
  轉為 `unknown`，**不**補上 `endedAt`（不把關閉時刻當作完成時間）。前端對 `unknown`
  顯示「未知（連線中斷）」，不是「已結束」；`background_not_tracked` 不受重啟影響
  （它從一開始就不在 `running`／`waiting_response` 之列），顯示「背景委派（本版未追蹤
  結果）」。
- 重複／晚到事件：`start()`／`end()`／`markStatus()` 都以 `(parentSessionId, toolUseId)`
  去重複；已是終態（`ended`／`failed`／`unknown`／`background_not_tracked`）的紀錄
  不會被稍後的事件覆寫或「復活」。
- 同一 Agent 同時多筆呼叫：以個別 `toolUseId` 分開追蹤，其中一筆結束不會把人物或其餘
  呼叫誤判為待命／已結束（見 `webview-ui/test/officeCharacters.test.ts` 的並行測試）。

## 5. Token：可選，本版尚未提供

目前**沒有**顯示任何 Token 數字——不是欄位被隱藏，是本版完全沒有寫入。

原因：`server/src/contextUsage.ts` 現有的 `contextTokens` 是「目前上下文視窗占用量」的
快照（會因壓縮／`/clear` 掉回小數字），使用者已明確要求不可拿它冒充消耗量。要正確算出
「歸屬到單一次呼叫」的用量，需要把該次呼叫時間窗內、且沒有其他並行呼叫互相干擾的
sidechain usage 記錄加總——這件事在有並行呼叫時容易算錯，一旦本輪時間有限，選擇不做，
以免顯示出不可靠但看起來像真的數字。`AgentCallUsage`／`usage_*` 欄位與 UI 顯示邏輯已
就位（`storage/src/callLog.ts`、`AgentPanel.tsx`），未來要接上時，只需要在
`callLogBridge.ts` 呼叫 `storage.callLog.setUsage(...)`。

## 6. 前端：整合的 Agent 面板

底部按鈕改名「Agent」，是所有 CC Agent 的單一入口——不只是呼叫歷史。

- `webview-ui/src/control/agentDirectory.ts`（新）：**唯一**一份「這個 Agent 現在算
  哪種狀態」的計算邏輯（`deriveAgentState`／`computeAgentSummaries`），供人物、整合
  列表、單一 Agent 詳情三處共用，避免各自算一次而彼此不一致。狀態優先序：任一呼叫
  `waiting_response` → 等待回應；任一呼叫 `running` → 工作中；都沒有時看「最近一次」
  呼叫——若它是 `unknown`（重啟／斷線後未確認結束）或 `background_not_tracked`（背景
  委派，本版不追蹤結果），回報**未知**，不會因為「查無正在執行的呼叫」就冒充「待命」；
  只有最近一次呼叫確實是 `ended`／`failed`，才是待命。同一 Agent 有多筆並行呼叫時，
  其中一筆結束或變成未知，不影響其餘仍在執行的呼叫——狀態只會因為「已經沒有任何一筆
  在跑」才降級。
- `webview-ui/src/control/useAgentDirectory.ts`（新，取代 `useTaskLog.ts`）：訂閱
  `nativeAgentRoster`／`agentCallLogSnapshot`／`agentCallUpdated`與 transport 本身的
  連線狀態，送出一次 `requestCallLog`，並用 `computeAgentSummaries` 算出
  `agents: AgentSummary[]`。
- `webview-ui/src/control/AgentPanel.tsx`（新，取代 `TaskLogPanel.tsx`）：兩個區塊。
  「Agent 狀態」——每個已掃描到的 Agent 一列（名稱／狀態／目前任務／執行時長），**即使
  完全沒有呼叫歷史也會列出**，待命列顯示「目前無執行任務」與執行時長「—」，從未被呼叫
  過的再加註「・尚未呼叫」。真的掃描不到任何 Agent 時顯示「尚未找到 CC Agent」與實際
  掃描位置（`nativeAgentRoster.root`，新增欄位）；連線中斷時明確標示「連線中斷」而不是
  顯示成待命或空白（已載入過的清單則保留最後已知狀態並加註提示，而不是整個清空）。
  「呼叫歷史」——沿用原本任務紀錄的欄位與展開行為，不變。點一列 Agent 狀態會開啟
  `AgentDetailPanel`。
- `webview-ui/src/control/AgentDetailPanel.tsx`（新）：單一 Agent 的名稱、狀態、目前
  任務、本次呼叫時間與執行時長、可歸屬的 Token（有才顯示）、完整呼叫歷史（可展開）。
  點擊辦公室裡的人物與點擊面板中的一列，開啟的是**同一個元件**、吃同一份
  `useAgentDirectory()` 資料，不會有兩邊顯示不一致的問題。編輯佈局模式時
  `OfficeCanvas.tsx` 既有的 `isEditMode` 判斷本來就會擋掉人物點擊，不需要額外處理。
- `webview-ui/src/control/callLogFormat.ts`（新）：呼叫狀態中文標籤與時間／時長格式化，
  供 `AgentPanel.tsx`／`AgentDetailPanel.tsx` 共用，確保兩處顯示規則一致。
- `App.tsx` 不再掛載 `OfficePanel`／`ProjectWorkspacePanel`／`AgentConfigPanel`（檔案
  本身保留，未刪除，只是不再被引用）。

## 7. 已知限制與後續

- 只支援 `Task`／`Agent` 兩種工具名稱的委派；若實際版本用第三種名稱，清單會漏記
  （見第 2 節）；獨立 `--agent` 會話仍不可觀測。
- 沒有 Token 資料（見第 5 節）。
- 極少數新版「隱性 Team」背景委派可能被誤標成「已結束」而非正確排除為既有的
  Teammate 機制（見第 2 節「已知殘留角落」）。
- Playwright e2e（`e2e/tests/browser/office-characters.spec.ts`）仍模擬舊的
  `officeState`／Project／Task 驅動流程，尚未針對新的 `nativeAgentRoster`／
  `agentCallLogSnapshot` 協定改寫；本輪的隔離驗證改由重寫後的
  `webview-ui/test/officeCharacters.test.ts` 與新增的
  `webview-ui/test/agentDirectory.test.ts` 涵蓋（見下方驗證指令）。真實瀏覽器 e2e
  改寫留待後續。
- Skills、知識庫、Agent 的 GitHub 私有同步仍由 CC 那側管理，未變動。

## 8. 回退方式

- 純前端：把 `App.tsx` 的 `<AgentPanel .../>`／`<AgentDetailPanel .../>` 換回
  `<OfficePanel .../>`（該元件與其依賴的 `useOfficeState.ts` 未被刪除），
  `BottomToolbar` 按鈕文字改回即可，不需要還原資料庫。
- 後端：`agent_calls` 是新增的獨立資料表（migration 4），未修改任何既有表；不想保留
  觀測資料時，直接 `DROP TABLE agent_calls`（或整個刪除 `~/.agent-office/agent-office.db`
  重新遷移）不會影響 `projects`／`agents`／`tasks`／`agent_sessions` 既有資料。
- 不需要刪除或重置 CC 原生 Agent 檔案（`~/.claude/agents/`）——Office 從未寫入這個目錄。

## 9. 測試污染真實 `~/.claude/agents` 的根因與修復

使用者回報 `~/.claude/agents` 下出現 `ux-*` 命名、指向
`Temp\agent-office-service-*\agents\<uuid>\discovery` 的 junction。

**根因**：`server/__tests__/officeService.test.ts`／`taskReview.test.ts`／
`taskExecution.test.ts`／`claudeSmoke.test.ts` 這四個測試檔用
`setOfficeDataRoot(tempDir)` 隔離了 SQLite 資料庫位置，但呼叫
`OfficeService.createAgent()`（測試裡建立名叫「UX Agent」／「UX」／「QA」的 Agent）時，
會觸發 CC discovery bridge 同步（`officeStorage.ts` 的 `syncAfterFileWrite`），這個
同步預設寫向**真正的** `~/.claude/agents`（因為這四個檔案從未呼叫
`setClaudeDiscoveryPaths` 覆寫掃描路徑）。測試結束後 `afterEach` 刪除暫存目錄，
真實 `~/.claude/agents` 下的 junction 就變成指向不存在路徑的殘留。

**已修復（程式碼，本次 commit 內）**：四個檔案都補上與 `officeAuthorization.test.ts`／
`officeCharacters.test.ts` 相同的 `setClaudeDiscoveryPaths({ claudeAgentsRoot: <暫存
子目錄>, ... })` 隔離，並在 `afterEach` 還原。之後再執行這些測試，不會再對真實
`~/.claude/agents` 寫入任何東西——已用這四個檔案的隔離測試跑過確認。

**尚未也無法由我這邊處理**：清理使用者機器上已經存在的殘留 junction。這個工作階段
沒有存取使用者 Windows 機器檔案系統的管道，只能提供下面這段唯讀盤點腳本，**請自行
執行、確認清單後再執行清除**（只移除 junction 本身，不遞迴刪除目標，因為目標多半已經
是不存在的暫存路徑）：

```powershell
# 第一步：唯讀盤點——只列出，不刪除任何東西
Get-ChildItem "$env:USERPROFILE\.claude\agents" | Where-Object {
  $_.LinkType -eq 'Junction'
} | ForEach-Object {
  [PSCustomObject]@{
    Name            = $_.Name
    Target          = $_.Target
    # 用「目標路徑含測試用的暫存資料夾名稱」判斷，而不是用 ux- 這種顯示名稱過濾——
    # 避免漏掉非 ux- 開頭、但同樣來自測試殘留的連結。
    LooksLikeTestLeak = $_.Target -match 'agent-office-(service|review|exec|smoke)-'
    TargetExists    = Test-Path $_.Target
  }
} | Format-Table -AutoSize
```

看過輸出、確認 `LooksLikeTestLeak` 為 `True`（且通常 `TargetExists` 為 `False`）的項目
確實是您列出的那幾個（或其他同樣符合模式的）之後，才用下面這段只刪 junction 本身的
指令逐一清除（`Remove-Item` 對 junction／reparse point，不加 `-Recurse` 時只會移除
連結本身，不會動到（早已不存在的）目標目錄；`skill-retriever.md` 或其他正式 Agent
一律不受影響，因為篩選條件只看測試暫存路徑特徵）：

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\agents" | Where-Object {
  $_.LinkType -eq 'Junction' -and $_.Target -match 'agent-office-(service|review|exec|smoke)-'
} | ForEach-Object {
  Write-Host "Removing junction: $($_.FullName) -> $($_.Target)"
  Remove-Item $_.FullName -Force
}
```

如果盤點結果跟預期不符（例如某個 `LooksLikeTestLeak=True` 的項目其實是您自己建立、
剛好路徑相似的東西），先不要執行清除指令，把輸出貼給我確認。

## 10. 驗證

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
- `server/__tests__/callLogCapture.test.ts`：`transcriptParser.ts` 的觀測點本身——
  `Task`／`Agent` 兩種工具名稱都會被解析、帶 `name` 的 Teammate 產生方式不會被誤記成
  一次呼叫、正常結果標記結束、非同步啟動確認標記 `background_not_tracked` 而非結束。
- `server/__tests__/callLogBridge.test.ts`：從一行模擬的 transcript 記錄開始，經
  `installCallLogBridge` 寫入真的（暫存）SQLite、比對真的（暫存）`~/.claude/agents`
  名單解析身分、到 `agentCallUpdated` 廣播——涵蓋「觀測事件能不能真的傳到資料庫與前端
  訊息」這條完整路徑，不是只測其中一段。
- `webview-ui/test/officeCharacters.test.ts`（改寫＋新增）：待命人物、roster 增減不
  重複、呼叫開始／結束切換工作狀態、未辨識呼叫不建立人物、並行呼叫互不影響、快照重置、
  最近一次呼叫是 `background_not_tracked`／`unknown` 時人物顯示「未知」而非「待命」
  且不播放工作動畫。
- `webview-ui/test/agentDirectory.test.ts`（新）：`deriveAgentState`／
  `computeAgentSummaries` 這個人物／整合列表／單一 Agent 詳情共用的狀態計算——沒有
  呼叫歷史時是待命、只有終態呼叫時是待命、任一呼叫執行中或等待回應時的優先序、並行
  呼叫其中一筆結束或變成未知不影響其餘仍在執行的呼叫、未辨識呼叫不歸屬到任何 Agent、
  即使零呼叫歷史也會列出每個 roster Agent。

這些測試合起來涵蓋「觀測事件 → 資料庫 → 廣播 → 前端人物／整合列表／單一 Agent 詳情」
整條路徑的每一段，且三處消費同一份狀態計算，但仍不是真的啟動 Claude 或開瀏覽器的
端對端測試——第 2 節列出的觀測缺口與已知邊界情況，仍需要下面的 Windows 真人驗收
才能確認。

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

1. 開啟輸出的網址；`~/.claude/agents/skill-retriever.md` 存在時，重新整理即可看到底部
   「Agent」面板列出 skill-retriever，狀態「待命」、目前任務「目前無執行任務」、執行
   時長「—」（若從未呼叫過，另外加註「・尚未呼叫」），不需要建立 Project 或 Office
   Task。
2. 點擊辦公室裡的 skill-retriever 人物，確認開啟的是同一個 Agent 的詳情，且待命狀態
   與面板一致（「Agent 詳情」跟「Agent 面板裡的那一列」不會有兩套不同的文字）。
3. 在一個一般 Claude Code 對話中，以 `Task` 或 `Agent` 工具委派
   `subagent_type: skill-retriever` 並給出真實任務文字。
4. 確認：人物切換「工作中」；Agent 面板該列狀態變「工作中」、目前任務與執行時長即時
   更新；點人物開啟的詳情也同步顯示「工作中」與相同任務內容；下方「呼叫歷史」新增
   一筆，呼叫時間／任務內容與實際相符。
5. 委派完成後：人物回到「待命」，面板該列與詳情都回到「待命」／「目前無執行任務」，
   歷史紀錄狀態變「已結束」，執行時長固定；重新整理瀏覽器後名單與紀錄仍在。
6. 重覆呼叫同一 Agent 兩次（或請它同時委派兩個子任務），確認呼叫歷史有兩筆各自獨立
   的紀錄，人物與面板不會因其中一筆先結束就顯示待命，沒有出現重複人物。
7. 編輯佈局（Layout 按鈕）時點擊人物，確認不會彈出 Agent 詳情、不干擾既有的選取／
   拖曳操作。

不得以模擬畫面或假事件取代第 3-6 步；Token 目前無資料可驗證（見第 5 節）。
