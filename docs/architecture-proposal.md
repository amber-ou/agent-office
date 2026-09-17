# Architecture Proposal — Milestone 1（設計，尚未實作）

前置文件：[`docs/architecture-audit.md`](./architecture-audit.md)
狀態：**待確認**。本文件只做設計，不含任何實作。經確認後才進入 Milestone 1 的程式碼工作。

---

## 1. 設計原則（從稽核結論推導）

1. **不動 upstream 的既有檔案**。所有新東西放在新的 top-level 目錄。理由：upstream 活躍開發中（v1.4.1），我們要保留 `git merge upstream/main` 的能力。改動既有檔案 = 未來每次都要解衝突。
2. **新增「下行」而不是改寫「上行」**。`AgentEvent`（觀測、單向）保持原樣不動；Task 派發是一條**全新的、獨立的**雙向通道。把指令塞進 `AgentEvent` 會污染一個設計良好的邊界。
3. **Domain 層零依賴、零 I/O**。可以被 `server/` 與 `webview-ui/` 同時 import，所以必須遵守 webview 的 `erasableSyntaxOnly`（禁 `enum`，一律用 `as const` union）。
4. **Storage 是 port/adapter**。domain 只認介面，不認 fs、不認 SQL。
5. **Feature flag 全程保護**。Control Plane 關閉時，行為與 upstream **逐位元組相同**。這是「不破壞現有 Pixel Office / Claude Code integration」唯一可驗證的定義。

---

## 2. 三個平面（Proposed Architecture）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION — Office UI（webview-ui/，沿用）                                 │
│  Canvas 2D 辦公室 + Layout editor + 【新】Project switcher + 【新】Inspector     │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ MessageTransport（沿用，協定擴充）
                                │ 上行：agentStatus / agentToolStart / ...（既有）
                                │ 【新】projectList / agentDefinitions / taskUpdated / ...
                                │ 下行：saveLayout / focusAgent / ...（既有）
                                │ 【新】createProject / createAgent / assignTask / ...
┌───────────────────────────────┴──────────────────────────────────────────────┐
│  CONTROL PLANE（全新，可上雲）                                                  │
│                                                                              │
│   server/src/control/            domain/（純邏輯，零依賴）                       │
│   ├─ projectService              ├─ Project / AgentDefinition / Task          │
│   ├─ agentService                ├─ Skill / KnowledgeRef / Output             │
│   ├─ taskService                 ├─ AgentSession（runtime 綁定）               │
│   ├─ knowledgeService            ├─ resolveAgentStatus()（7 態解析器）          │
│   └─ runtimeBridge/              └─ repositories.ts（port 介面）               │
│        register / heartbeat                                                  │
│        dispatchTask / reportStatus      storage/（adapter 實作）               │
│        submitOutput                     ├─ memory/（測試）                     │
│                                         ├─ file/（開發預設）                    │
│   ↑ 擁有：Projects, Agents, Tasks,      ├─ sqlite/（Milestone 2）              │
│     Knowledge metadata, Outputs,        └─ postgres/（Milestone 9）            │
│     Office layout, Agent config                                              │
└──────────┬───────────────────────────────────┬───────────────────────────────┘
           │ 【新】Runtime Bridge 協定          │ 既有 hook ingress（沿用，不動）
           │ register / heartbeat / task /      │ POST /api/hooks/:providerId
           │ status / progress / output         │
           ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  AGENT RUNTIME（可與 Control Plane 同機，也可不同機）                            │
│                                                                              │
│  AgentRuntimeAdapter 介面的實作：                                               │
│   • LocalClaudeCliRuntime   — 在本機 spawn claude 程序（Milestone 6 第一版）     │
│   • VsCodeTerminalRuntime   — 沿用 upstream 的 terminal 啟動                    │
│   • RemoteRuntime           — 遠端主機，透過 Runtime Bridge 回報（Milestone 9）  │
│   • （未來）Codex / Gemini / 自訂 MCP agent                                     │
│                                                                              │
│  這一層仍然會產生 hook 事件 → 走既有的 AgentEvent 管線 → 角色動起來（免費沿用）     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**兩條通道並存，職責分離：**

| | 既有 AgentEvent 通道 | 新 Runtime Bridge 通道 |
|---|---|---|
| 方向 | Runtime → Control Plane（單向） | 雙向 |
| 語意 | 「發生了什麼」（觀測） | 「該做什麼 / 做到哪了 / 產出是什麼」（控制） |
| 傳輸 | `POST /api/hooks/:providerId`（既有） | WS 或 HTTP（見 §7） |
| 是否改動 upstream | **完全不動** | 全新 |
| 驅動 | 角色動畫、context gauge、bubble | Task 狀態、Agent 狀態、Output |

---

## 3. Data Model

全部放在 `domain/src/`，純型別 + 純函式。命名避開 upstream 既有型別（upstream 的 `AgentState` / `PersistedAgent` 保持原意不動）。

### 3.1 識別碼

```ts
// domain/src/ids.ts — branded types，避免把 ProjectId 傳進吃 AgentId 的地方
export type ProjectId       = string & { readonly __brand: 'ProjectId' };
export type AgentId         = string & { readonly __brand: 'AgentId' };
export type TaskId          = string & { readonly __brand: 'TaskId' };
export type SkillId         = string & { readonly __brand: 'SkillId' };
export type KnowledgeId     = string & { readonly __brand: 'KnowledgeId' };
export type OutputId        = string & { readonly __brand: 'OutputId' };
export type SessionId       = string & { readonly __brand: 'SessionId' };
```

全部是 UUID 字串。**刻意不沿用 upstream 的 `number` agent id** —— 那個 id 是 per-adapter、重啟後續接的計數器，不是穩定身分。兩者透過 `AgentSession` 綁定（§3.4）。

### 3.2 Project

```ts
export const ProjectStatus = {
  ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export interface Project {
  id: ProjectId;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;            // ISO 8601，全 domain 統一
  updatedAt: string;
  settings: ProjectSettings;
}

export interface ProjectSettings {
  /** 這個 Project 的工作目錄（agent runtime 的 cwd）。可為空＝尚未綁定。 */
  workspacePaths: string[];
  /** 未指定 model 的 agent 用這個 */
  defaultProvider?: string;     // 'claude' | 'codex' | ...
  defaultModel?: string;
  /** Office：這個 Project 用哪一份 layout、對應到哪些 Area label */
  layoutId?: string;
  areaLabels?: string[];
  /** 未來 Shared Knowledge 的入口：可讀取哪些其他 Project 的 knowledge */
  sharedKnowledgeFrom?: ProjectId[];
}
```

> 規格中的 `agents[] / tasks[] / knowledge[] / outputs[]` **刻意不放在 `Project` 物件裡**。
> 理由：那是 aggregate 邊界問題。若內嵌，每次改一個 Task 就要重寫整個 Project；換成 SQL 後更是反模式。
> 改為：子實體各自持有 `projectId` 外鍵，由 repository 提供 `listByProject(projectId)`。
> 需要「一包完整的 Project」時，用 `ProjectAggregate`（下）當**讀取模型**，不是儲存模型。

```ts
export interface ProjectAggregate {
  project: Project;
  agents: AgentDefinition[];
  tasks: Task[];
  knowledge: KnowledgeRef[];
  outputs: OutputRef[];
}
```

### 3.3 AgentDefinition（「這個員工是誰」）

```ts
export const AgentStatus = {
  OFFLINE:   'offline',
  IDLE:      'idle',
  WORKING:   'working',
  WAITING:   'waiting',
  REVIEWING: 'reviewing',
  BLOCKED:   'blocked',
  ERROR:     'error',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export interface AgentDefinition {
  id: AgentId;
  projectId: ProjectId;
  name: string;                  // "UX Agent"
  role: string;                  // "ux" — 穩定鍵，UI 與預設 prompt 用
  description: string;
  systemPrompt: string;
  provider: string;              // 'claude' —— 對應 HookProvider.id，不寫死
  model?: string;                // 未填則用 ProjectSettings.defaultModel
  skills: SkillId[];
  tools: ToolGrant[];
  /** Manager → 下屬。用於 Milestone 8 的 orchestration，現在只是資料。 */
  managerAgentId?: AgentId;
  memory: AgentMemoryConfig;
  /** 視覺：沿用 upstream 的 palette / hueShift / seat，讓角色外觀跨重啟穩定 */
  appearance: AgentAppearance;
  createdAt: string;
  updatedAt: string;
}

export interface ToolGrant {
  name: string;                  // 'Read' | 'Write' | 'Bash' | 'mcp__foo__bar'
  mode: 'allow' | 'ask' | 'deny';
}

export interface AgentMemoryConfig {
  /** 帶進每次 session 的長期記憶（markdown）。上限由 storage 決定。 */
  notes: string;
  /** 自動帶入最近幾個已完成 Task 的摘要 */
  recentTaskSummaryLimit: number;
}

export interface AgentAppearance {
  palette?: number;              // 0-5，對應 upstream
  hueShift?: number;             // 0-360
  seatId?: string | null;
}
```

**`status` 不存在 `AgentDefinition` 裡。** 它是衍生值（§3.6）。把衍生值持久化必然 stale。

### 3.4 AgentSession（「這個員工現在正在執行哪一次工作」）

這是 Definition/Runtime 分離的關鍵，也是接上 upstream 的橋。

```ts
export const SessionState = {
  STARTING: 'starting', RUNNING: 'running', IDLE: 'idle',
  ENDED: 'ended', FAILED: 'failed',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

export interface AgentSession {
  id: SessionId;
  agentId: AgentId;              // ← Definition。Session 結束後 Definition 不動
  projectId: ProjectId;
  taskId?: TaskId;               // 這次 run 是為了哪個 Task
  state: SessionState;

  // ── 與 upstream 觀測層的綁定（單向、可為空）──
  /** upstream AgentStateStore 的數字 id。process-local，重啟後失效，故 optional。 */
  runtimeAgentId?: number;
  /** Claude 的 session_id (UUID)。這才是跨重啟可對上的鍵。 */
  providerSessionId?: string;
  /** transcript 路徑，給 heuristic 模式對帳用 */
  transcriptPath?: string;

  /** 哪一台 runtime 在跑它（Milestone 9 的多機場景） */
  runtimeId?: string;
  startedAt: string;
  endedAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
}
```

> **關鍵設計**：`AgentSession` 是唯一知道 upstream `number` id 的地方。
> upstream 那一側（`AgentStateStore`、`fileWatcher`、`hookEventHandler`）**完全不知道 Project / Agent / Task 的存在**，一行都不用改。
> 對帳方向是單向的：Control Plane 在派工時已知 `providerSessionId`（因為它是自己 mint 的 `--session-id`），
> 之後 upstream 的 `agentCreated` 帶著同一個 sessionId 冒出來，Control Plane 認領它、寫回 `runtimeAgentId`。

### 3.5 Task

```ts
export const TaskStatus = {
  BACKLOG: 'backlog', TODO: 'todo', IN_PROGRESS: 'in_progress',
  REVIEW: 'review', BLOCKED: 'blocked', DONE: 'done', FAILED: 'failed',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskPriority = {
  LOW: 'low', NORMAL: 'normal', HIGH: 'high', URGENT: 'urgent',
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  description: string;
  assignedAgentId?: AgentId;
  /** 誰建立的。undefined = 人類建立；有值 = Manager Agent 或其他 Agent 建立 */
  createdByAgentId?: AgentId;
  parentTaskId?: TaskId;
  status: TaskStatus;
  priority: TaskPriority;
  /** 必須全部 done 才能進 in_progress */
  dependencies: TaskId[];
  inputs: TaskInput[];
  outputs: OutputId[];
  createdAt: string;
  updatedAt: string;
}

export type TaskInput =
  | { kind: 'text';      value: string }
  | { kind: 'knowledge'; knowledgeId: KnowledgeId }
  | { kind: 'output';    outputId: OutputId }      // 上一個 agent 的產出 → 這個 agent 的輸入
  | { kind: 'file';      path: string };
```

`TaskInput` 是 discriminated union 而不是 `string[]`，因為「Agent → Agent 交接」的本質就是**前者的 output 變成後者的 input**，這必須是型別上可表達的，否則 Milestone 8 會退化成字串拼接。

**狀態機**（純函式 `canTransition(from, to, ctx)`，寫在 domain，有單元測試）：

```
backlog → todo → in_progress → review → done
                      ↓          ↓
                   blocked ←─────┘
                      ↓
                    todo
   in_progress / review → failed → todo（重派）
```

規則：進 `in_progress` 需要 `assignedAgentId` 且所有 `dependencies` 皆為 `done`。

### 3.6 Agent 狀態解析器（7 態怎麼來）

這是稽核發現的硬落差：upstream wire 上只有 `active | waiting`，而規格要 7 態。
解法是**兩個來源合成一個**，寫成 domain 的純函式：

```ts
export interface ObservedActivity {         // 來自 upstream 觀測通道
  present: boolean;                          // 有沒有活著的 session
  active: boolean;                           // agentStatus === 'active'
  awaitingInput: boolean;                    // turnEnd 的 awaitingInput
  permissionPending: boolean;                // agentToolPermission 未清除
}

export function resolveAgentStatus(
  session: AgentSession | undefined,
  currentTask: Task | undefined,
  observed: ObservedActivity | undefined,
): AgentStatus;
```

判定順序（先到先得）：

| 結果 | 條件 | 來源 |
|---|---|---|
| `error` | `session.state === 'failed'` 或 `task.status === 'failed'` | Control Plane |
| `blocked` | `task.status === 'blocked'` | Control Plane |
| `reviewing` | `task.status === 'review'` 且此 agent 是 reviewer | Control Plane |
| `waiting` | `observed.permissionPending` 或 `observed.awaitingInput` | **觀測** |
| `working` | `observed.active` | **觀測** |
| `idle` | 有 session，無上述情況 | 觀測 |
| `offline` | 無 session | Control Plane |

**結論：7 態中有 3 態（`reviewing` / `blocked` / `error`）物理上不可能從 Claude 的 hook 事件推導出來，必須由 Task 狀態提供。** 這反過來證明 Task domain 是 Office UI 狀態表達的前置條件，不是加分項。

### 3.7 Skill

```ts
export interface Skill {
  id: SkillId;
  /** 全域唯一 slug，例如 'ux-research'。Agent 用它引用。 */
  slug: string;
  name: string;
  description: string;
  /** null = 全域 skill（跨 Project 可用）；有值 = Project 私有 */
  projectId: ProjectId | null;
  /** 注入 agent 的內容。用 source 抽象，不寫死 markdown 檔。 */
  source: SkillSource;
  /** 這個 skill 需要哪些工具才能運作 */
  requiredTools: string[];
  createdAt: string;
  updatedAt: string;
}

export type SkillSource =
  | { kind: 'inline';   content: string }
  | { kind: 'file';     path: string }
  | { kind: 'claudeSkill'; name: string }   // 對接 Claude Code 既有 skill 機制
  | { kind: 'mcp';      server: string; tool?: string };
```

Skill 與 Agent 是多對多（`AgentDefinition.skills: SkillId[]`），因此同一個 `ux-research` 可被 UX Agent 與 Research Agent 共用。

### 3.8 Knowledge / Output

兩者共用同一個抽象：**metadata 進 repository，內容進 blob store**。理由：規格說未來要放 PRD、UX research、上傳文件 —— 內容可能是 MB 級，不該塞進同一個 JSON/資料列。

```ts
export interface KnowledgeRef {
  id: KnowledgeId;
  projectId: ProjectId;
  title: string;
  kind: KnowledgeKind;          // 'markdown' | 'prd' | 'ux-research' | 'user-flow'
                                // | 'design-system' | 'ui-spec' | 'api-doc' | 'upload'
  tags: string[];
  /** 內容位置的抽象，不綁 local fs */
  blob: BlobRef;
  /** 未來檢索用；Milestone 7 才填 */
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export type BlobRef =
  | { store: 'file';   path: string }
  | { store: 'inline'; content: string }
  | { store: 'url';    url: string }
  | { store: 's3';     bucket: string; key: string };

export interface OutputRef {
  id: OutputId;
  projectId: ProjectId;
  taskId: TaskId;
  producedByAgentId: AgentId;
  sessionId: SessionId;
  title: string;
  kind: 'markdown' | 'diff' | 'file' | 'json' | 'link';
  blob: BlobRef;
  createdAt: string;
}
```

### 3.9 Context 組裝（避免「每個 agent 每次讀全部資料」）

規格明確要求分層。設計成一個純函式 + 一個預算：

```ts
export interface AgentContextRequest {
  agent: AgentDefinition;
  project: Project;
  task: Task;
  budget: { maxKnowledgeItems: number; maxChars: number };
}

export interface AgentContextBundle {
  globalInstructions: string;    // 系統層（跨 Project）
  projectContext: string;        // Project 描述 + settings 摘要
  agentRole: string;             // systemPrompt + skills 展開
  knowledge: KnowledgeRef[];     // 只選相關的，見下
  task: Task;                    // 含 inputs（可能引用其他 agent 的 output）
}
```

**相關性選取策略（Milestone 1 只定介面，實作留到 Milestone 7）：**

```ts
export interface KnowledgeSelector {
  select(req: AgentContextRequest, all: KnowledgeRef[]): KnowledgeRef[];
}
```

Milestone 7 的第一版實作為 `TagAndKindSelector`（用 agent.role → 偏好的 `KnowledgeKind` + Task 標籤過濾），之後可換成 embedding 檢索**而不動 domain**。

---

## 4. Proposed Directory Structure

```
agent-office/
├── LICENSE                     ← upstream MIT，原封不動保留
├── NOTICE                      ← 【新】註明 fork 自 pixel-agents-hq/pixel-agents @ 3537e14
├── UPSTREAM.md                 ← 【新】上游同步紀錄與流程
│
├── core/                       ← upstream，不動（asyncapi.yaml 除外，只做 additive 擴充）
├── server/
│   ├── src/                    ← upstream 既有檔案，不動
│   │   └── control/            ← 【新】Control Plane 的 server 層
│   │        ├── projectService.ts
│   │        ├── agentService.ts
│   │        ├── taskService.ts
│   │        ├── knowledgeService.ts
│   │        ├── sessionBinder.ts      ← 把 upstream 的 number id 接上 AgentSession
│   │        ├── statusProjector.ts    ← 觀測 + Task → AgentStatus 廣播
│   │        ├── runtimeBridge/
│   │        │    ├── protocol.ts
│   │        │    ├── registry.ts      ← runtime 註冊 / heartbeat / 逾時
│   │        │    └── dispatcher.ts    ← Task → Runtime
│   │        └── routes.ts
│   └── __tests__/              ← upstream，不動；新測試放 __tests__/control/
│
├── adapters/vscode/            ← upstream，不動
├── webview-ui/
│   └── src/
│       ├── （upstream 既有，不動）
│       └── control/            ← 【新】Project switcher / Agent Inspector / Task 面板
│
├── domain/                     ← 【新】npm workspace，純 TS，零 runtime 依賴
│   ├── package.json
│   └── src/
│        ├── ids.ts
│        ├── project.ts  agentDefinition.ts  agentSession.ts
│        ├── task.ts  skill.ts  knowledge.ts  output.ts
│        ├── status.ts           ← resolveAgentStatus
│        ├── transitions.ts      ← canTransition + 狀態機
│        ├── context.ts          ← AgentContextBundle / KnowledgeSelector
│        ├── repositories.ts     ← 所有 port 介面
│        ├── errors.ts
│        └── index.ts
│
├── storage/                    ← 【新】npm workspace，domain port 的實作
│   ├── package.json
│   └── src/
│        ├── memory/            ← Milestone 1（測試用，唯一在 M1 交付的實作）
│        ├── file/              ← Milestone 2（開發預設）
│        ├── sqlite/            ← Milestone 2
│        ├── blob/              ← BlobStore 的 file / inline 實作
│        └── index.ts
│
├── runtime/                    ← 【新】Milestone 6，AgentRuntimeAdapter 實作
│   └── src/
│        ├── adapter.ts         ← AgentRuntimeAdapter 介面（M1 只定介面）
│        ├── localClaudeCli.ts  ← M6
│        └── vscodeTerminal.ts  ← M6
│
└── docs/
     ├── architecture-audit.md       ← Milestone 0（已完成）
     ├── architecture-proposal.md    ← 本文件
     └── adr/                        ← 沿用 upstream 的 ADR 慣例
```

**層級規則（擴充 upstream 的 `CLAUDE.md` 規則）：**

```
domain/     → 依賴 nothing
storage/    → 依賴 domain/
runtime/    → 依賴 domain/ + core/
core/       → 依賴 nothing（upstream 原規則）
server/     → 依賴 core/ + domain/ + storage/ + runtime/
webview-ui/ → 依賴 core/ + domain/（僅型別）
adapters/   → 依賴 core/ + server/
```

`webview-ui` 能 import `domain/` 是刻意的：Inspector 要顯示 `AgentStatus`、`TaskStatus`，型別必須共用。**因此 `domain/` 必須通過 webview 的 `erasableSyntaxOnly` 檢查 —— 不得使用 `enum`，一律 `as const`。** 上面所有型別都已遵守。

---

## 5. Repository / Storage 抽象

```ts
// domain/src/repositories.ts —— 全部是介面，零實作
export interface Repository<T, Id> {
  get(id: Id): Promise<T | null>;
  put(entity: T): Promise<void>;
  delete(id: Id): Promise<void>;
}

export interface ProjectRepository extends Repository<Project, ProjectId> {
  list(filter?: { status?: ProjectStatus }): Promise<Project[]>;
}

export interface AgentRepository extends Repository<AgentDefinition, AgentId> {
  listByProject(projectId: ProjectId): Promise<AgentDefinition[]>;
  findByRole(projectId: ProjectId, role: string): Promise<AgentDefinition | null>;
}

export interface TaskRepository extends Repository<Task, TaskId> {
  listByProject(projectId: ProjectId, filter?: { status?: TaskStatus[] }): Promise<Task[]>;
  listByAgent(agentId: AgentId, filter?: { status?: TaskStatus[] }): Promise<Task[]>;
  listChildren(parentTaskId: TaskId): Promise<Task[]>;
}

export interface SessionRepository extends Repository<AgentSession, SessionId> {
  findByProviderSessionId(providerSessionId: string): Promise<AgentSession | null>;
  listActiveByProject(projectId: ProjectId): Promise<AgentSession[]>;
}

export interface SkillRepository extends Repository<Skill, SkillId> {
  listAvailable(projectId: ProjectId): Promise<Skill[]>;   // 全域 + 該 Project 私有
}

export interface KnowledgeRepository extends Repository<KnowledgeRef, KnowledgeId> {
  listByProject(projectId: ProjectId, filter?: { kind?: KnowledgeKind[]; tags?: string[] }): Promise<KnowledgeRef[]>;
}

export interface OutputRepository extends Repository<OutputRef, OutputId> {
  listByTask(taskId: TaskId): Promise<OutputRef[]>;
  listByProject(projectId: ProjectId): Promise<OutputRef[]>;
}

/** 內容存放，與 metadata 分離 */
export interface BlobStore {
  read(ref: BlobRef): Promise<string>;
  write(hint: { projectId: ProjectId; name: string }, content: string): Promise<BlobRef>;
  delete(ref: BlobRef): Promise<void>;
}

/** 跨 repository 的原子操作（例如「建 Task + 改 Agent + 寫 Output」） */
export interface UnitOfWork {
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface Repositories {
  projects: ProjectRepository; agents: AgentRepository; tasks: TaskRepository;
  sessions: SessionRepository; skills: SkillRepository;
  knowledge: KnowledgeRepository; outputs: OutputRepository; blobs: BlobStore;
}
```

**全部 `Promise` 回傳，即使記憶體實作是同步的。** 這是不可協商的：如果 M1 定成同步介面，換 PostgreSQL 時每個呼叫點都要改，抽象就白做了。

開發期磁碟布局（`storage/src/file/`），對齊規格的目錄結構：

```
<dataRoot>/projects/<project-id>/
    project.json
    agents/<agent-id>.json
    tasks/<task-id>.json
    sessions/<session-id>.json
    knowledge/<knowledge-id>.json      ← metadata
    knowledge/blobs/<...>              ← 內容
    outputs/<output-id>.json
    outputs/blobs/<...>
<dataRoot>/skills/<skill-id>.json      ← 全域 skill
```

`<dataRoot>` 預設 `~/.agent-office/`（**與 upstream 的 `~/.pixel-agents/` 分開**，避免污染 upstream 的檔案、也讓 upstream 的 uninstall 流程不會誤刪我們的資料）。

---

## 6. Office UI 擴充（Milestone 4 設計，M1 不實作）

原則：**不重新設計 Office，只做加法。**

| 項目 | 做法 |
|---|---|
| Project switcher | 放在既有 `BottomToolbar.tsx` 旁。切換時送 `setActiveProject` ClientMessage，**server 端過濾**（不是前端隱藏）—— 這同時解決稽核 §10 的「WS 無 scoping」雲端阻礙 |
| Agent Inspector | 點角色 → 既有 `selectedAgentId` 已存在，只需新增一個側邊面板元件讀 `agentDefinitions` / `tasks` |
| 7 種狀態動畫 | **不新增 FSM 狀態**。`working` → 既有 TYPE/READ；`idle` → 既有 wander；`waiting` → 既有 bubble；`offline` → 既有 ghost 半透明機制（`isHeadless`）；`reviewing` / `blocked` / `error` → **新增 3 個 bubble sprite**，沿用既有 `bubbleType` 機制 |
| Project ↔ Office 位置 | 直接沿用 `areaMappings` + `findFreeSeat(folderName)` 的兩階段選位，把 key 從 `folderName` 擴充成可接受 `projectId` |
| Per-project layout | `ProjectSettings.layoutId` → `~/.agent-office/layouts/<id>.json`；無值時 fallback 到 upstream 的 `~/.pixel-agents/layout.json`（維持既有行為） |

**必須遵守的 upstream 約束（CI 會擋）：**

- 新 UI 不得寫死顏色字面值（`no-inline-colors`，error 級）→ 一律用 `index.css` 的 `--pixel-*` 變數
- 陰影必須是 `var(--pixel-shadow)` 或 `2px 2px 0px`（`pixel-shadow`）
- 字型必須引用 FS Pixel Sans（`pixel-font`）
- `borderRadius: 0`、`2px solid` 邊框 —— 像素風一致性

---

## 7. Runtime Bridge 協定（Milestone 6 設計，M1 只定介面）

```ts
// runtime/src/adapter.ts
export interface AgentRuntimeAdapter {
  readonly id: string;
  readonly kind: 'local-cli' | 'vscode-terminal' | 'remote';

  /** 開一個 session 給這個 agent 執行這個 task。回傳 providerSessionId。 */
  startSession(req: {
    agent: AgentDefinition;
    context: AgentContextBundle;
    cwd: string;
  }): Promise<{ providerSessionId: string; transcriptPath?: string }>;

  /** 對執行中的 session 追加指示（Milestone 8 的 Manager 需要） */
  sendMessage(providerSessionId: string, text: string): Promise<void>;

  stopSession(providerSessionId: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

**Control Plane ↔ Runtime 的 6 個動詞**（規格要求，設計為獨立訊息族）：

| 動詞 | 方向 | 說明 |
|---|---|---|
| `register` | Runtime → CP | 宣告自己是誰、支援哪些 provider、能跑哪些 Project |
| `heartbeat` | Runtime → CP | 定期存活；逾時 → 該 runtime 上的 session 標記 `failed` |
| `dispatchTask` | CP → Runtime | 帶 `AgentContextBundle` |
| `reportStatus` | Runtime → CP | session 狀態變化 |
| `reportProgress` | Runtime → CP | 中間進度（可選；角色動畫仍走既有 hook 通道） |
| `submitOutput` | Runtime → CP | 產出 → `OutputRef` |

**傳輸選擇**：本機用**同 process 直接呼叫**（M6 第一版，零網路成本）；遠端用 **WebSocket**（`/api/runtime/ws`，runtime 主動連出）。
選 WS 而非 HTTP polling 的理由：runtime 通常在 NAT / 防火牆後（使用者的筆電、VPS），**由 runtime 連出**才不需要 inbound 可達性；而 `dispatchTask` 需要 server 主動推送。這與既有的 `POST /api/hooks/` 併存不衝突 —— 那條是 hook script 的一次性 fire-and-forget，這條是長連線。

**Milestone 6 第一版實作建議：`LocalClaudeCliRuntime`**，用 headless 模式 spawn（`claude -p ... --session-id <uuid>`，確切旗標需在 M6 對照當時安裝的 CLI 版本驗證）。
好處是：這是一個**真正的 Claude session**，所以既有的 hook + transcript 管線會自動亮起來，角色動畫、context gauge、permission bubble **全部免費沿用，零改動**。
不建議走 `terminal.sendText(prompt)` 注入：只能在 VS Code、無法取得結構化產出、且與使用者手動輸入競爭同一個 stdin。

---

## 8. Migration Strategy

### Phase A — 建立 base（Milestone 1 第一步，需先確認）

```bash
git remote add upstream https://github.com/pixel-agents-hq/pixel-agents
git fetch upstream
# 以 upstream v1.4.1 (3537e14) 作為 v1.0 的起點，保留完整 history 以利日後 merge
```

- `LICENSE` 原封不動；新增 `NOTICE` 註明 fork 來源與 commit SHA；`README.md` 頂部保留 upstream attribution。
- **暫不改名**：npm package name、VS Code extension id、`~/.pixel-agents/` 路徑全部保持 upstream 原樣直到 Milestone 3。改名很便宜，merge 衝突很貴。

### Phase B — Additive only（Milestone 1–3）

| 規則 | 理由 |
|---|---|
| 新程式碼一律放新目錄 | 保住 `git merge upstream/main` |
| `core/asyncapi.yaml` 只新增 channel，不改既有 27+18 訊息 | CI 有 drift check；改既有訊息 = 破壞既有 UI |
| **絕不手改 `core/src/messages.ts`** | 它是 codegen 產物，改了下次 generate 就沒了，且 CI 會擋 |
| Feature flag `AGENT_OFFICE_CONTROL_PLANE=0`（預設關） | 關閉時行為與 upstream 完全相同，這是「不破壞」的可驗證定義 |
| 每個 milestone 跑 `check-types` + `lint` + `test` + `build`，各自一個 commit | 規格要求 |

### Phase C — 上游同步

`UPSTREAM.md` 記錄最後同步的 SHA。定期 `git merge upstream/main`；因為所有改動都在新目錄，衝突面應僅限於 `package.json`（workspaces）、`tsconfig.json`、`eslint.config.mjs`、`knip.json` 這 4 個檔案。

### 既有資料的相容性

`~/.pixel-agents/` 的既有檔案**全部照讀照寫不動**。新資料寫 `~/.agent-office/`。
使用者從 upstream 升級上來時：layout、座位、設定、hooks consent 全部保留；Project 列表為空 → Office 行為與升級前完全一致。

---

## 9. Cloud Deployment Constraints（現在就必須納入設計的）

| # | 限制 | 對設計的影響 |
|---|---|---|
| 1 | **Hooks 必須裝在 Claude 執行的那台機器**（寫 `~/.claude/settings.json`） | Control Plane 不能負責安裝 hooks；由 Agent Runtime 那一側負責。`installHooks(serverUrl, token)` 的 `serverUrl` 必須能是**公網 URL**，目前寫死 `http://127.0.0.1:<port>` |
| 2 | **Heuristic 模式在雲端不可用**（沒有本機 transcript） | 雲端部署時 hooks 是**唯一**偵測方式 → hook 送達的可靠性成為關鍵路徑，需要重試與冪等 |
| 3 | **Server 探索靠本機檔案**（`~/.pixel-agents/servers/*.json` + `process.kill(pid,0)`） | 遠端 runtime 無法用這個機制 → 必須改成顯式設定（URL + 憑證），即規格的 `register` |
| 4 | **目前沒有使用者身分**（一個 process token = 全部權限） | 多租戶前必須加 identity 層。M1–M8 可單租戶，但**資料模型不能假設單租戶** → 所有實體已帶 `projectId`，未來加 `ownerId` 是 additive |
| 5 | **WS 無 scoping**，每條連線收到所有 agent 事件 | Project switcher 必須**server 端過濾**。這同時是雲端多租戶的隔離基礎 |
| 6 | **特權模型是 bearer token 放在 URL query** | 明文進瀏覽器歷史與 server log。公網部署必須換掉（OAuth / session cookie + CSRF） |
| 7 | **Ephemeral container 無持久化** | **Milestone 2（Persistence）必須先於 Milestone 9（Cloud）完成**，順序不可調換 |
| 8 | Assets 從本機 `dist/assets` 載入 | 隨 server bundle 出貨即可，非阻礙 |
| 9 | Agent Runtime 與 UI 不同機時，**時鐘不同步** | 所有時間戳用 ISO 8601 UTC 字串；`lastHeartbeatAt` 由 **Control Plane** 蓋章，不信任 runtime 自報 |

---

## 10. Milestone 1 預計修改哪些 files

**Milestone 1 的目標：只交付 domain 層 + in-memory storage + 測試。零行為變更，Office 與 Claude 整合完全不受影響。**

### 新增

| 檔案 | 內容 |
|---|---|
| `domain/package.json` | workspace 宣告 |
| `domain/tsconfig.json` | 繼承根設定 + `erasableSyntaxOnly` |
| `domain/src/ids.ts` | branded id types + `newProjectId()` 等 |
| `domain/src/project.ts` | `Project`, `ProjectSettings`, `ProjectStatus`, `ProjectAggregate` |
| `domain/src/agentDefinition.ts` | `AgentDefinition`, `ToolGrant`, `AgentMemoryConfig`, `AgentAppearance` |
| `domain/src/agentSession.ts` | `AgentSession`, `SessionState` |
| `domain/src/task.ts` | `Task`, `TaskStatus`, `TaskPriority`, `TaskInput` |
| `domain/src/skill.ts` | `Skill`, `SkillSource` |
| `domain/src/knowledge.ts` | `KnowledgeRef`, `KnowledgeKind`, `BlobRef` |
| `domain/src/output.ts` | `OutputRef` |
| `domain/src/status.ts` | `AgentStatus`, `ObservedActivity`, `resolveAgentStatus()` |
| `domain/src/transitions.ts` | Task / Session 狀態機 + `canTransition()` |
| `domain/src/context.ts` | `AgentContextBundle`, `AgentContextRequest`, `KnowledgeSelector` |
| `domain/src/repositories.ts` | 所有 port 介面 |
| `domain/src/errors.ts` | `DomainError` 階層 |
| `domain/src/index.ts` | public API |
| `storage/package.json`, `storage/tsconfig.json` | workspace |
| `storage/src/memory/*.ts` | 每個 repository 的記憶體實作 + `MemoryUnitOfWork` |
| `storage/src/index.ts` | factory |
| `runtime/src/adapter.ts` | `AgentRuntimeAdapter` 介面（**只有介面，無實作**） |
| `domain/__tests__/*.test.ts` | 狀態機、`resolveAgentStatus` 全 7 態、id branding |
| `storage/__tests__/*.test.ts` | repository 合約測試（同一組測試日後直接套用到 file / sqlite 實作） |
| `NOTICE`, `UPSTREAM.md` | 授權與上游追蹤 |

### 修改（4 個檔案，都是小改）

| 檔案 | 改動 |
|---|---|
| `package.json` | `workspaces` 加入 `domain`, `storage`, `runtime`；`test` script 串接新 workspace |
| `tsconfig.json` | 加入新 project reference |
| `eslint.config.mjs` | lint 範圍加入新目錄 |
| `knip.json` | 新 entry points（否則 knip 會報未使用） |
| `CLAUDE.md` | 層級規則段落補上新目錄（維護 upstream 的文件慣例） |

### Milestone 1 **不碰**

`server/src/**`、`webview-ui/src/**`、`adapters/**`、`core/asyncapi.yaml`、`core/src/**`。
驗收標準：`npm run check-types && npm run lint && npm test && npm run build` 全綠，且 `git diff` 對既有檔案的改動僅限上表 5 個檔案。

---

## 11. 這個 repository 適合作為 base 嗎

**適合。建議採用。** 理由與保留意見如下。

### 支持採用的具體理由

1. **抽象邊界已經畫在對的位置。** `HookProvider`（CLI 整合）、`MessageTransport`（傳輸）、`StateAdapter`（持久化）、`TeamProvider`（團隊）四個介面都已存在且乾淨。規格要求的「不要把 provider 寫死為 Claude」「不要把 storage 寫死為 local filesystem」—— 前者 upstream 已經做到，後者已經有介面（`StateAdapter`）只是實作單一。**這些是最難補的部分，而它已經有了。**
2. **協定有單一事實來源且 CI 保護。** `core/asyncapi.yaml` → codegen → drift check。要加 Project/Task/Agent 訊息族，有現成且被強制執行的流程，不會出現前後端型別漂移。
3. **Office UI 是完成品，且成本極高難以重建。** Canvas 2D 渲染、pathfinding、角色 FSM、自動貼圖牆面、家具 manifest、carpet auto-tiling、layout editor、undo/redo、匯入匯出、pets、Areas —— 約 13,500 行，是規格明確要保留的部分。從零重做這塊是數個月工作。
4. **Areas + `findFreeSeat(folderName)` 幾乎就是 Project 的視覺雛型。** 兩階段選位（先找 mapped area、找不到才全域）正是「切換 Project 只顯示該 Project agents」需要的機制，可直接擴充而非重寫。
5. **工程品質高於一般 OSS。** 550 個單元測試、Playwright e2e（含 mock-claude scenario runner）、嚴格分層（`core` 零依賴）、自訂 ESLint 規則守護設計風格、ADR 文件、詳盡的 `CLAUDE.md` 與 `CONTEXT.md` 詞彙表。實測 typecheck 0 error、lint 0 error、549/550 測試通過（唯一失敗是 root 容器的權限假象）。
6. **相依極輕。** production dependencies 只有 4 個（fastify 家族）。沒有需要拆除的框架債。
7. **MIT 授權**，fork 與商業化皆可，只需保留 attribution。

### 必須誠實說明的保留意見

1. **我們要蓋的東西，upstream 一行都沒有。** Project / Agent definition / Task / Skill / Knowledge / storage 抽象 / database / Control Plane —— 全部從零。upstream 提供的是**觀測 + 呈現**，我們要的是**管理 + 執行**。
2. **這是一次方向性的擴張，不是延伸。** upstream 的核心設計決定是「Agent ≡ session」與「事件單向流動」。我們要的是「Agent ≡ 長期角色」與「雙向控制」。這兩者不衝突，但也不是同一件事 —— 因此本提案把它做成**並存的第二條通道**，而不是改寫既有通道。
3. **upstream 持續開發中，我們是下游。** 需要紀律：所有改動放新目錄、不碰既有檔案、定期 merge。若未來大量修改 upstream 檔案，同步成本會快速上升到「等同於分道揚鑣」。
4. **README 與程式碼已有不一致**（`--no-terminal` 只存在於 README）。代表 upstream 文件不能盡信，實作細節要以程式碼為準 —— 本次稽核所有結論皆以程式碼驗證。
5. **`number` agent id 是隱性債。** 它是 per-adapter 計數器，不是穩定身分。本提案用 `AgentSession` 隔離它，但只要 upstream 還在用，跨機器、跨重啟的對帳就永遠要經過 `providerSessionId` 這一層轉換。

### 結論

採用 pixel-agents 作為 base，可以省下的是**視覺層與觀測層**（約 20,000 行成熟程式碼 + 測試基礎建設）；要付出的是**從零建立 Control Plane**。以本專案的目標而言，這個交換是划算的 —— 因為省下的那部分正是規格明確要保留的（Pixel Office UI），而要建的那部分無論用什麼 base 都得建。

---

## 12. 待確認事項

進入 Milestone 1 實作前，需要你的決定：

1. **確認採用此 base**，以及 Phase A 的 fork 方式（保留 upstream git history 以利日後同步）。
2. **確認 domain model** 是否符合你的心智模型 —— 特別是 §3.2 把 `agents[] / tasks[]` 從 `Project` 物件中移出（改用外鍵 + `ProjectAggregate` 讀取模型）這個偏離規格字面的決定。
3. **確認 Milestone 1 的範圍** = 純 domain + in-memory storage + 測試，不動任何既有檔案。
4. **資料目錄** 使用 `~/.agent-office/`（與 upstream 的 `~/.pixel-agents/` 分離）。
