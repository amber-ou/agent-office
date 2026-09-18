/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | SettingsLoaded
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | WorkspaceFolders
  | AgentDiagnostics
  | OfficeState
  | OfficeError
  | AgentDetail
  | ProjectDetail
  | OutputContent;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | RequestDiagnostics
  | RequestOffice
  | CreateProject
  | SetActiveProject
  | CreateAgent
  | AddAgentToProject
  | RemoveAgentFromProject
  | CreateTask
  | RequestAgentDetail
  | UpdateAgent
  | CreateSkill
  | UpdateSkill
  | DeleteSkill
  | CreateAgentKnowledge
  | UpdateAgentKnowledge
  | DeleteAgentKnowledge
  | RequestProjectDetail
  | UpdateProject
  | CreateProjectKnowledge
  | UpdateProjectKnowledge
  | DeleteProjectKnowledge
  | UpdateTask
  | AssignTask
  | UnassignTask
  | SetTaskStatus
  | DeleteTask
  | RunTask
  | CancelTaskRun
  | RequestOutputContent
  | AcceptTask
  | RequestTaskChanges;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface WorkspaceFolders {
  type: 'workspaceFolders';
  folders: WorkspaceFolder[];
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface OfficeState {
  type: 'officeState';
  storage: OfficeStorageStatus;
  projects: OfficeProject[];
  agents: OfficeAgent[];
  memberships: OfficeMembership[];
  tasks: OfficeTask[];
  activeProjectId?: string;
}

export interface OfficeStorageStatus {
  ready: boolean;
  schemaVersion: number;
  databasePath?: string;
  error?: string;
}

export interface OfficeProject {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt?: string;
  provider: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeMembership {
  id: string;
  projectId: string;
  agentId: string;
  seatId?: string;
}

export interface OfficeTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedAgentId?: string;
  parentTaskId?: string;
  dependencies: string[];
  inputs: OfficeTaskInput[];
  createdAt: string;
  updatedAt: string;
}

export interface OfficeTaskInput {
  kind: string;
  value?: string;
  knowledgeId?: string;
  outputId?: string;
  path?: string;
}

export interface OfficeError {
  type: 'officeError';
  operation: string;
  message: string;
}

export interface AgentDetail {
  type: 'agentDetail';
  fileBacked?: boolean;
  configIssue?: string;
  agent: OfficeAgent;
  skills: OfficeSkill[];
  knowledge: OfficeAgentKnowledge[];
}

export interface OfficeSkill {
  id: string;
  agentId: string;
  slug: string;
  name: string;
  description: string;
  kind: string;
  requiredTools: string[];
  content?: string;
}

export interface OfficeAgentKnowledge {
  id: string;
  agentId: string;
  type: string;
  title: string;
  tags: string[];
  content?: string;
  contentReadable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  type: 'projectDetail';
  project: OfficeProjectDetail;
  memberships: OfficeMembership[];
  knowledge: OfficeProjectKnowledge[];
  tasks: OfficeTask[];
  sessions: OfficeSession[];
  outputs: OfficeOutput[];
  reviewNotes: OfficeReviewNote[];
}

export interface OfficeProjectDetail {
  id: string;
  name: string;
  description: string;
  status: string;
  workspacePaths: string[];
  defaultProvider?: string;
  defaultModel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeProjectKnowledge {
  id: string;
  projectId: string;
  type: string;
  title: string;
  tags: string[];
  content?: string;
  contentReadable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeSession {
  id: string;
  agentId: string;
  projectId: string;
  taskId?: string;
  provider: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  providerSessionId?: string;
}

export interface OfficeOutput {
  id: string;
  projectId: string;
  taskId: string;
  producedByAgentId: string;
  sessionId?: string;
  title: string;
  type: string;
  createdAt: string;
}

export interface OfficeReviewNote {
  id: string;
  taskId: string;
  aboutSessionId?: string;
  triggeredSessionId?: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface OutputContent {
  type: 'outputContent';
  outputId: string;
  title?: string;
  readable: boolean;
  content?: string;
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  folderPath?: string;
  bypassPermissions?: boolean;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface RequestOffice {
  type: 'requestOffice';
}

export interface CreateProject {
  type: 'createProject';
  name: string;
  description?: string;
}

export interface SetActiveProject {
  type: 'setActiveProject';
  projectId?: string;
}

export interface CreateAgent {
  type: 'createAgent';
  name: string;
  role: string;
  provider: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
}

export interface AddAgentToProject {
  type: 'addAgentToProject';
  projectId: string;
  agentId: string;
}

export interface RemoveAgentFromProject {
  type: 'removeAgentFromProject';
  projectId: string;
  agentId: string;
}

export interface CreateTask {
  type: 'createTask';
  projectId: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  priority?: string;
  parentTaskId?: string;
  dependencies?: string[];
  inputs?: OfficeTaskInput[];
}

export interface RequestAgentDetail {
  type: 'requestAgentDetail';
  agentId?: string;
}

export interface UpdateAgent {
  type: 'updateAgent';
  agentId: string;
  name?: string;
  role?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
}

export interface CreateSkill {
  type: 'createSkill';
  agentId: string;
  slug: string;
  name: string;
  kind: string;
  description?: string;
  content?: string;
  requiredTools?: string[];
}

export interface UpdateSkill {
  type: 'updateSkill';
  agentId: string;
  skillId: string;
  slug?: string;
  name?: string;
  kind?: string;
  description?: string;
  content?: string;
  requiredTools?: string[];
}

export interface DeleteSkill {
  type: 'deleteSkill';
  agentId: string;
  skillId: string;
}

export interface CreateAgentKnowledge {
  type: 'createAgentKnowledge';
  agentId: string;
  title: string;
  knowledgeType: string;
  content: string;
  tags?: string[];
}

export interface UpdateAgentKnowledge {
  type: 'updateAgentKnowledge';
  agentId: string;
  knowledgeId: string;
  title?: string;
  knowledgeType?: string;
  content?: string;
  tags?: string[];
}

export interface DeleteAgentKnowledge {
  type: 'deleteAgentKnowledge';
  agentId: string;
  knowledgeId: string;
}

export interface RequestProjectDetail {
  type: 'requestProjectDetail';
  projectId?: string;
}

export interface UpdateProject {
  type: 'updateProject';
  projectId: string;
  name?: string;
  description?: string;
  status?: string;
  workspacePaths?: string[];
  defaultProvider?: string;
  defaultModel?: string;
}

export interface CreateProjectKnowledge {
  type: 'createProjectKnowledge';
  projectId: string;
  title: string;
  knowledgeType: string;
  content: string;
  tags?: string[];
}

export interface UpdateProjectKnowledge {
  type: 'updateProjectKnowledge';
  knowledgeId: string;
  title?: string;
  knowledgeType?: string;
  content?: string;
  tags?: string[];
}

export interface DeleteProjectKnowledge {
  type: 'deleteProjectKnowledge';
  knowledgeId: string;
}

export interface UpdateTask {
  type: 'updateTask';
  taskId: string;
  title?: string;
  description?: string;
  priority?: string;
  parentTaskId?: string;
  clearParentTask?: boolean;
  dependencies?: string[];
  inputs?: OfficeTaskInput[];
}

export interface AssignTask {
  type: 'assignTask';
  taskId: string;
  agentId: string;
}

export interface UnassignTask {
  type: 'unassignTask';
  taskId: string;
}

export interface SetTaskStatus {
  type: 'setTaskStatus';
  taskId: string;
  status: string;
}

export interface DeleteTask {
  type: 'deleteTask';
  taskId: string;
}

export interface RunTask {
  type: 'runTask';
  taskId: string;
}

export interface CancelTaskRun {
  type: 'cancelTaskRun';
}

export interface RequestOutputContent {
  type: 'requestOutputContent';
  outputId: string;
}

export interface AcceptTask {
  type: 'acceptTask';
  taskId: string;
}

export interface RequestTaskChanges {
  type: 'requestTaskChanges';
  taskId: string;
  feedback: string;
}
