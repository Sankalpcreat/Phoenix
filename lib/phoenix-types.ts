export type SocketStatus = "connecting" | "connected" | "disconnected";
export type PhoenixStatus = "idle" | "starting" | "running" | "waiting_for_user" | "failed";
export type AgentProvider = "claude" | "codex";

export interface ProviderModelOption {
  id: string;
  label: string;
  supportsEffort: boolean;
}

export interface ProviderEffortOption {
  id: string;
  label: string;
}

export interface ProviderCatalogEntry {
  id: AgentProvider;
  label: string;
  defaultModel: string;
  defaultEffort?: string;
  supportsPlanMode: boolean;
  models: ProviderModelOption[];
  efforts: ProviderEffortOption[];
}

export interface SidebarChatRow {
  _id: string;
  _creationTime: number;
  chatId: string;
  title: string;
  status: PhoenixStatus;
  localPath: string;
  provider: AgentProvider | null;
  lastMessageAt?: number;
  hasAutomation: boolean;
}

export interface SidebarProjectGroup {
  groupKey: string;
  localPath: string;
  chats: SidebarChatRow[];
}

export interface SidebarData {
  projectGroups: SidebarProjectGroup[];
}

export interface LocalProjectSummary {
  localPath: string;
  title: string;
  source: "saved" | "discovered";
  lastOpenedAt?: number;
  chatCount: number;
}

export interface LocalProjectsSnapshot {
  machine: {
    id: "local";
    displayName: string;
  };
  projects: LocalProjectSummary[];
}

export interface ChatRuntime {
  chatId: string;
  projectId: string;
  localPath: string;
  title: string;
  status: PhoenixStatus;
  provider: AgentProvider | null;
  planMode: boolean;
  sessionToken: string | null;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export type ToolInput =
  | { command: string; description?: string; timeoutMs?: number; runInBackground?: boolean }
  | { filePath: string; content?: string; oldString?: string; newString?: string }
  | { query: string }
  | { questions: Array<{ id?: string; question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }> }
  | { plan?: string; summary?: string }
  | { todos: TodoItem[] }
  | { server: string; tool: string; payload: Record<string, unknown> }
  | { subagentType?: string }
  | { payload: Record<string, unknown> }
  | Record<string, unknown>;

export interface ToolDescriptor {
  kind?: "tool";
  toolName?: string;
  toolKind?: string;
  toolId?: string;
  input?: ToolInput;
  rawInput?: Record<string, unknown>;
}

export type TranscriptEntry =
  | { _id: string; createdAt: number; kind: "user_prompt"; content: string; hidden?: boolean }
  | {
      _id: string;
      createdAt: number;
      kind: "system_init";
      provider: AgentProvider;
      model: string;
      tools: string[];
      agents: string[];
      slashCommands: string[];
      mcpServers: Array<{ name: string; status: string; error?: string }>;
      hidden?: boolean;
    }
  | { _id: string; createdAt: number; kind: "assistant_text"; text: string; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "status"; status: string; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "result"; subtype: "success" | "error" | "cancelled"; result: string; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "tool_call"; tool: ToolDescriptor; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "tool_result"; toolId: string; content: unknown; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "account_info"; accountInfo: Record<string, unknown>; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "compact_boundary"; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "compact_summary"; summary: string; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "context_cleared"; hidden?: boolean }
  | { _id: string; createdAt: number; kind: "interrupted"; hidden?: boolean }
  | { _id: string; createdAt: number; kind: string; hidden?: boolean };

export interface ChatSnapshot {
  runtime: ChatRuntime;
  messages: TranscriptEntry[];
  availableProviders: ProviderCatalogEntry[];
}

export type SubscriptionTopic =
  | { type: "sidebar" }
  | { type: "local-projects" }
  | { type: "chat"; chatId: string };

export type ClientCommand =
  | { type: "chat.create"; projectId: string }
  | { type: "chat.cancel"; chatId: string }
  | {
      type: "chat.send";
      chatId?: string;
      projectId?: string;
      provider?: AgentProvider;
      content: string;
      model?: string;
      effort?: string;
      planMode?: boolean;
    };

export type ClientEnvelope =
  | { v: 1; type: "subscribe"; id: string; topic: SubscriptionTopic }
  | { v: 1; type: "unsubscribe"; id: string }
  | { v: 1; type: "command"; id: string; command: ClientCommand };

export type ServerSnapshot =
  | { type: "sidebar"; data: SidebarData }
  | { type: "local-projects"; data: LocalProjectsSnapshot }
  | { type: "chat"; data: ChatSnapshot | null };

export type ServerEnvelope =
  | { v: 1; type: "snapshot"; id: string; snapshot: ServerSnapshot }
  | { v: 1; type: "ack"; id: string; result?: unknown }
  | { v: 1; type: "error"; id?: string; message: string };
