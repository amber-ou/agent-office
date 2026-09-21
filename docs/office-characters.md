# Office Agent 人物

> **已由 [`task-log.md`](./task-log.md) 取代人物來源與呼叫觀測的部分**：人物現在來自
> CC 原生 Agent 名單（`~/.claude/agents`），不再依賴本文件描述的 Office
> Project／AgentDefinition／Task／AgentSession。本文件保留供歷史對照；程式碼中的
> `webview-ui/src/office/engine/officeCharacters.ts` 已改為新機制，下面的座位／走路／
> 動畫素材說明仍然適用。

沿用 Pixel Agents 的人物素材、座位、走路與工作動畫。

- 選取專案後，該專案的每個成員會顯示一個人物，不需要先執行 Task。
- 未選取專案時顯示 Agent Library；重新整理後可再選取專案。
- 人物顯示 Agent 名稱，以及待命、工作中、等待審核、受阻或執行失敗狀態。
- 點人物可開啟 Agent 設定。人物不提供關閉 Claude 程序的按鈕。
- 移除專案成員會移除該專案畫面的人物，不會刪除 Agent Library 的 Agent。
- 以 Office session ID／Claude provider session ID 關聯執行活動，避免任務啟動後出現第二個人物；不以名稱猜測關聯。
- 建立人物本身不會呼叫模型，也不需要開啟 Watch All Sessions。精確的工具動畫與權限提示仍依賴原有的工作階段偵測。

## 更新後驗證

1. 停止舊的 Office 程序，更新程式後執行 `npm.cmd ci`、`npm.cmd run build`。
2. 執行 `node .\dist\cli.js`，開啟輸出的網址，重新整理瀏覽器。
3. Office → 選取已有 `skill-retriever` 的專案，關閉面板，確認人物及「待命」標籤。
4. 重新整理，確認 Agent Library 人物能恢復；不必重複登錄 Agent。

這項變更不會替原生 Agent 補齊 MCP 或更改其指令。真實任務的 MCP／權限與輸出需另行驗證。

## 開發驗證

```sh
npm run check-types
npm run lint
npm run build:webview
cd webview-ui
npm test -- test/officeCharacters.test.ts test/greeter.test.ts test/existingAgents.test.ts test/teammateSeating.test.ts
cd ../server
npm test -- __tests__/officeCharacters.test.ts __tests__/agentStateStore.test.ts
cd ..
npx playwright test --config e2e/office-characters.config.ts
```

瀏覽器測試使用真實前端與素材、模擬 WebSocket 資料，不啟動 Claude 或讀寫使用者的 Office 資料。預設使用 Playwright Chromium；本機已有 Edge 時可設定 `PLAYWRIGHT_CHANNEL=msedge`。
