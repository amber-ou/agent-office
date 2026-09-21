# Agent Office — 進度與下一步

更新日期：2026-09-20 ｜ 分支 `v1.0` ｜ 開發端最後 commit `e377594`
Windows 使用者：Amber ｜ 儲存庫：`amber-ou/agent-office`

## 0. 證據界線

- **已實作**＝開發端程式與測試完成，**不等於**在使用者 Windows 實跑過。
- **Windows 已驗證**＝使用者實際輸出或畫面能支持的項目。
- Linux 測試通過、mock 參數測試、檔案橋接測試，**都不等於**真實 Claude Agent
  派工成功。
- 本文的「程式行為」敘述已對照 `e377594` 的原始碼確認（下方標註 ✓ 者）。

---

## 1. 產品決策（現行）

**Claude Code 原生 Agent 檔案是唯一權威來源；Agent Office 是登錄、管理與派工介面。**

```
CC 建立／維護原生 Agent → Office 登錄來源關聯 → Office 指派任務
→ Claude 以指定 Agent 執行 → Office 保存結果
```

1. 不要求在 Office 再填一份 System Prompt／Instructions。
2. 不建立第二份需同步維護的 Agent 定義。
3. CC 改原始檔後，下一次派工即讀到更新，不需重新 link。
4. 派工須實際使用指定的 CC Agent；複製原始檔文字進一般 prompt 不算等價。
5. Office 自行保存 Project／Task／Session／Output／Review，不自動轉成 Agent 永久知識。
6. 最終需本機檔案 ＋ GitHub 私有庫同步，供多台電腦複用。
7. 私有 Agent 儲存庫預定名稱 `agent-office-agents`；Knowledge 一併同步，
   認證／token／transcript／SQLite／runtime **不**納入。

## 2. 近期目標與門檻分級

**目標：一個 CC 原生 Agent，在 Windows Office 登錄後重啟仍在，並完成一次簡單任務。**

| 門檻               | 條件                                               | 現況       |
| ------------------ | -------------------------------------------------- | ---------- |
| 可以建立 Agent     | 在 CC 建立原生檔案                                 | 現在即可   |
| 可以放進 Office    | 本機已更新並建置登錄功能，且登錄成功               | 待做       |
| 可以開始小規模使用 | 完成一次真實任務，指定 Agent 執行、可查看及 Accept | 待做       |
| 完整驗收通過       | —                                                  | **未達成** |

第一個 Agent 只要名稱、用途與必要工作指示。Skills 與大型 Knowledge 不列入第一輪門檻。

---

## 3. 原生 CC Agent 登錄與派工（`99f8335`、`e377594`）

以下已對照 `server/src/control/taskRunner.ts`、`runtime/src/claudeCliRuntime.ts`、
`runtime/src/promptRenderer.ts` 確認：

- ✓ `npm run link-native-agent` 登錄既有 CC 原生 Agent；Office 以 `nativeAgentPath` 記錄來源關聯。
- ✓ 派工參數為 `--agent <name>`，且 **`--agent` 與 `--model` 互斥**，不會以
  Office 的 model 覆蓋原生設定。
- ✓ **不複製 persona**：原生 Agent 的 prompt 只含「Operating instructions ＋
  Task ＋ Project」（`renderNativeAgentPrompt`），不含 persona、Skills、
  AgentKnowledge。
- ✓ **每次派工重新讀原始檔**，並**重新驗證可唯一定位**（同名衝突、檔案已變動都會
  在派工當下再檢查一次），不依賴 link 當時的快取。
- ✓ 來源限定在使用者 `~/.claude/agents/` 樹內；同樹存在相同 frontmatter name 時拒絕。
- ✓ 檔案含未解決的 git conflict marker → 拒絕登錄與派工。
- ✓ **Linux／WSL2 沙箱模式下，原生關聯 Agent 一律拒絕派工**（`~/.claude` 刻意在
  namespace 之外），錯誤訊息明示需以 Windows shell 模式執行，不靜默退回複製 prompt。

以上仍需在 Windows 完成最小實際流程驗證。檔案位置與同名檢查是**目前實作範圍**，
不等於已涵蓋 Claude 所有設定來源與優先順序。

### 顯示快取的限制 ✓

- **下一次派工**：重新讀原始檔（權威）。
- **Office 清單／詳細面板**：原生關聯 Agent 不算 file-backed，`agentDetail` 走
  資料庫列 —— CC 編輯後畫面**不會**自動更新。
- 重新 link 可刷新顯示，但日常派工不應依賴此步驟。

正確說法是：**原始檔是權威來源，Office 有非權威的顯示快取。**
不可把畫面中的舊文字當成實際派工內容。

### Knowledge 連接方式（原 §8 待確認項）✓

**目前 Office 的 AgentKnowledge 與原生 CC Agent 之間沒有自動互通。**
原生關聯 Agent 的派工 prompt 不含任何 Office Skills／AgentKnowledge；
knowledge 指標與 discovery 橋接只作用於**已檔案化**的 Office Agent，不作用於
原生關聯 Agent。要讓原生 Agent 用到知識，必須從 CC 那一側配置。

---

## 4. Office 核心能力（既有，已凍結）

- 全域 Agent、Project、Task、成員與指派管理；SQLite ＋ 檔案持久化。
- Run → Output → Review → Accept／Request changes → 續跑（`--resume` 續同一 session）。
- 一次只跑一個 Task；不做平行或多 Agent 編排。
- Windows shell 模式 ＋ 一次性風險同意；Linux／WSL2 沙箱不可用即拒絕派工。
- Office control plane 全部讀寫訊息需 server token。
- 資料邊界：Project／Task／Output／review feedback 永不自動變成 Agent 永久知識。

里程碑：M0 `fc585db`、M1 `322dda8`、M2 `03324ca`、M3 `be60a41`／`a7f4e4a`／`339cf38`、
M4 `4b077b1`／`a894847`、M5 `f06f77e`／`9ed0545`／`cb54945`、Windows `510632c`、
CC 橋接 `e8cc9ca`…`e377594`。

---

## 5. Windows 已驗證（使用者實測）

環境：PowerShell、原生 Windows（不走 WSL）、Node v22.17.0、Claude Code v2.1.276
（`C:\Users\amber\.local\bin\claude.exe`，PATH 已處理）。
新 checkout `C:\Users\amber\agent\agent-office-v1.0-new`，舊資料夾 `…\agent-office-1.0`。

已完成：

- npm 安裝與 build。
- 以 **`node .\dist\cli.js`** 啟動 Office，瀏覽器可開啟介面。
- Windows 一次性 shell consent 成功記錄。
- `verify:cc-bridge` 的 packaged build 啟動、測試 Agent 建立、junction、discovery
  範圍、欄位分離與 Knowledge 指標檢查通過。
- storage 測試曾為 141 passed。

⚠ 入口更正：實際成功的入口是 **`dist/cli.js`**。repo 內確認**不存在** `.mjs` 入口
（`dist/` 只有 `cli.js`、`extension.js`、`uninstall.js`），舊 log 的 `.mjs` 指示是錯的。
`agent-office.cmd` 是同等入口但**尚未實測**。

---

## 6. 測試現況（兩套數字，不可混用）

| 環境                             | 結果                                        |
| -------------------------------- | ------------------------------------------- |
| 開發 Linux 容器 `npm test`       | 646 passed ／ 1 failed ／ 1 skipped         |
| **Windows**（`bac86d9`，使用者） | **570 passed ／ 56 failed ／ 18 skipped**   |
| Windows `verify:cc-bridge`       | 8 pass ／ 1 fail（fail 是整組 test-server） |
| Windows server 測試              | 7 files failed ／ 30 passed ／ 1 skipped    |

Linux 那 1 failed 是 `claudeHookInstaller` 的 root 權限問題，與 Windows 無關。
**不可用 Linux 數字代表 Windows 現況。**

### Windows 觀察到的問題

- 測試寫入正式 `C:\Users\amber\.pixel-agents\config.json`，rename EPERM。
- consent／config 預期與實際不符、資料殘留、ENOENT。
- mock Claude 子程序 timeout。
- taskExecution 未記錄到預期 Claude 呼叫；taskReview 取到 undefined。
- Windows 路徑跳脫比對失敗；listen ENOBUFS。
- 背景 bridge 工作出現 SQLite database is closed。

**已定位的根因（✓ 本次查證）**：`configPersistence.test.ts`、`consentFlow.test.ts`、
`clientMessageHandler.test.ts` 只覆寫 `process.env.HOME`，**沒有覆寫 `USERPROFILE`**。
Node 在 Windows 上 `os.homedir()` 取 `USERPROFILE`，所以這三支測試在 Windows 會落到
**真實的** `%USERPROFILE%\.pixel-agents\`——這就是 EPERM 與 config 殘留的來源。
（其他 7 支測試用 `vi.mock('os')` 覆寫 `homedir`，不受影響。）

開發端之後回報部分相關測試通過，但**未取得更新後的完整 Windows 結果**，
上述問題不可標成已修復。

### 對近期工作的原則

- **不以整套測試全綠作為使用門檻。**
- 不再執行可能寫入正式設定的測試；必要自動驗證必須隔離。
- 不刪測試、不放寬斷言、不停用同意檢查換取通過。
- 只優先修與「第一個 Agent 登錄／保存／派工」直接相關的錯誤。
- 若最小流程涉及正式設定風險或資料損壞，仍須先處理。

---

## 7. 最短執行順序

**第一步 — 確定第一個 Agent**：向使用者取得 ①名稱 ②用途與基本工作指示
③是否已有原生檔案及路徑。不自行建立範例 Agent。檔案須位於
`~/.claude/agents/`（目前登錄功能支援的位置）。

**第二步 — 備份並更新本機**：確認目前 checkout commit 與 build 狀態（不假設已是
`e377594`）；停止本次 Office 實例（不按名稱殺光 node）；備份 Office 資料與原生
Agent 來源；正常 fast-forward 更新，有本機改動先看不硬重設；只做必要安裝與 build，
不重跑全套測試。指令用 PowerShell ＋ `npm.cmd`，不混入 CMD 語法。

**第三步 — 登錄、啟動與重啟確認**：Office 停止時以 `link-native-agent` 登錄**確定
存在**的原始檔（不給仍含 `<name>` 的佔位指令）→ `node .\dist\cli.js` 啟動 → 確認
Agent 可見 → 重啟後關聯仍在 → 改原始指示後確認派工讀到更新（UI 快取未更新須明說）。

**第四步 — 一次真實任務**：建 Project、加入 Agent、指派簡單 Task；任務文字先經使用者
確認才呼叫模型；確認以指定原生 Agent 啟動、結果可查看與 Accept。
單靠 Agent 自報名字**不足以**證明原生選擇成功，需結合啟動參數或執行紀錄（不暴露憑證）。
遇阻塞只修該點、回報原始錯誤，不擴大架構。

**完成第四步即可開始小規模使用。**

---

## 8. 大型知識庫

- 現在可準備原始資料與分類，不必立即搬移。
- 第一個 Agent 跑通後，先加少量代表性 Knowledge，驗證可讀取、路徑可解析、內容可用。
- 不把整個知識庫塞進 Agent 本文；用分類檔案、索引與按需讀取。
- ✓ 已確認：Office AgentKnowledge 與原生 CC Agent **不會**自動互通（見 §3）。
- 保留原始資料；大量 PDF／圖片／二進位檔先評估 Git 儲存方式。

## 9. 備份與同步邊界

- **Office**：停止服務後一致備份 `agent-office.db`、`agents/`、`blobs/`，
  以及需保留的設定。`runtime/` 是暫存。詳見 [backup-and-restore.md](backup-and-restore.md)。
- **CC**：另外備份實際原生 Agent 檔案；加入 Skills／Knowledge 後納入其來源位置。
- 只備份 `.agent-office` **不足以**備份新方案中的原生 Agent。
- 不把整個 `.claude` 推上 GitHub（含認證與會話資料）。

GitHub 私有同步仍是正式後續交付，**尚無建立／首次推送完成的證據**。需交付：私有 repo、
納入／排除範圍、首次同步、第二台電腦登錄或連結重建、日常 pull／commit／push 步驟。

## 10. 可延後

完整 Windows 回歸測試與無關的 hooks 問題；WSL2／Linux 沙箱驗收；Office → CC 方向橋接
完整驗收；完整 Request changes／resume 驗收；顯示快取自動刷新與匯入 UI；GitHub 多主機
同步與完整 Skills／Knowledge 配置；多 Agent 編排、Manager、平行執行、自動記憶、RAG、
雲端、多使用者、UI 重設計。

延後不等於取消——GitHub 私有同步與大型知識庫仍是目標。

---

## 11. 完成標準

**一個使用者要的 CC 原生 Agent，在 Windows Office 重啟後仍可使用，並完成一次經使用者
確認的真實任務。**

接手者請勿重啟大型設計或要求全套測試先通過。先確認第一個 Agent 的名稱、用途與原始檔
是否存在，再依目前程式與本機狀態給出最短 PowerShell 步驟；若無法完成，指出卡在
「建立／登錄／保存／原生選擇／執行」哪一步，完成最小修正。

## 附：決策紀錄

[ADR 索引](adr/README.md)（001–008）。與本階段最相關：
[007 Agent 檔案儲存](adr/007-agent-file-storage.md)、
[008 執行沙箱與控制平面授權](adr/008-run-sandbox.md)。
