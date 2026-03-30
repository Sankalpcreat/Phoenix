import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DrawerLayoutAndroid,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePhoenixClient } from "@/hooks/use-phoenix-client";
import type { AgentProvider, ProviderCatalogEntry, SidebarChatRow, SidebarProjectGroup, ToolDescriptor, TranscriptEntry } from "@/lib/phoenix-types";

const DEFAULT_SERVER_URL = "";

type ThemeMode = "light" | "dark";
type SheetKind = null | "provider" | "model" | "theme" | "effort" | "attach";
type AttachmentDraft = { id: string; name: string; kind: "image" | "file" };

const PROVIDER_OPTIONS: {
  id: AgentProvider;
  label: string;
  subtitle: string;
  models: string[];
}[] = [
  {
    id: "codex",
    label: "Codex",
    subtitle: "Remote coding on your Mac",
    models: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
  },
  {
    id: "claude",
    label: "Claude",
    subtitle: "Claude Code sessions",
    models: ["sonnet", "opus", "haiku"],
  },
];

const THEME_OPTIONS: { id: ThemeMode; label: string; subtitle: string }[] = [
  { id: "light", label: "Light", subtitle: "Soft paper and glass" },
  { id: "dark", label: "Dark", subtitle: "Night mode for terminal work" },
];

const EFFORT_OPTIONS = {
  codex: [
    { id: "low", label: "Low", subtitle: "Faster replies" },
    { id: "medium", label: "Medium", subtitle: "Balanced" },
    { id: "high", label: "High", subtitle: "Deeper reasoning" },
    { id: "xhigh", label: "Extra High", subtitle: "Maximum depth" },
  ],
  claude: [
    { id: "low", label: "Low", subtitle: "Faster replies" },
    { id: "medium", label: "Medium", subtitle: "Balanced" },
    { id: "high", label: "High", subtitle: "Deeper reasoning" },
    { id: "max", label: "Max", subtitle: "Maximum depth" },
  ],
} as const;

const FALLBACK_PROVIDERS: ProviderCatalogEntry[] = PROVIDER_OPTIONS.map((option) => ({
  id: option.id,
  label: option.label,
  defaultModel: option.models[0] ?? "",
  defaultEffort: option.id === "codex" ? "high" : "high",
  supportsPlanMode: true,
  models: option.models.map((modelId) => ({
    id: modelId,
    label: formatModelLabel(modelId),
    supportsEffort: true,
  })),
  efforts: getProviderEfforts(option.id).map((effortOption) => ({
    id: effortOption.id,
    label: effortOption.label,
  })),
}));

function getProviderModels(provider: AgentProvider) {
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.models ?? [];
}

function getProviderEfforts(provider: AgentProvider) {
  return EFFORT_OPTIONS[provider];
}

function formatModelLabel(model: string) {
  return model.replace("-codex", "").replace("-spark", " Spark").replace("gpt-", "GPT-");
}

function trimPath(path: string, keep = 26) {
  if (path.length <= keep) return path;
  return `...${path.slice(-(keep - 3))}`;
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatJson(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactMultiline(value: string, limit = 6) {
  const lines = value.split(/\r?\n/);
  if (lines.length <= limit) return value;
  return `${lines.slice(0, limit).join("\n")}\n…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatDuration(durationMs: number | null) {
  if (durationMs == null || Number.isNaN(durationMs)) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function commandResultDetails(content: unknown) {
  const record = asRecord(content);
  return {
    output:
      typeof content === "string"
        ? content
        : typeof record?.aggregatedOutput === "string"
          ? record.aggregatedOutput
          : typeof record?.output === "string"
            ? record.output
            : null,
    exitCode: typeof record?.exitCode === "number" ? record.exitCode : null,
    durationMs: typeof record?.durationMs === "number" ? record.durationMs : null,
    status: typeof record?.status === "string" ? record.status : null,
  };
}

function getActiveProviders(chatProviders?: ProviderCatalogEntry[]) {
  return chatProviders?.length ? chatProviders : FALLBACK_PROVIDERS;
}

function getCatalogProvider(providers: ProviderCatalogEntry[], provider: AgentProvider) {
  return providers.find((candidate) => candidate.id === provider) ?? getActiveProviders()[0];
}

function getEffortChoices(provider: AgentProvider, catalogEntry?: ProviderCatalogEntry) {
  if (catalogEntry?.efforts?.length) {
    return catalogEntry.efforts.map((entry) => ({
      id: entry.id,
      label: entry.label,
      subtitle: provider === "codex" ? "Codex reasoning" : "Claude reasoning",
    }));
  }
  return [...getProviderEfforts(provider)];
}

function resolveToolTitle(tool: ToolDescriptor) {
  if (tool.toolName) return tool.toolName;
  if (tool.toolKind) return titleCase(tool.toolKind);
  return "Tool";
}

function resolveToolSummary(tool: ToolDescriptor) {
  const input = tool.input as Record<string, unknown> | undefined;
  switch (tool.toolKind) {
    case "bash":
      return typeof input?.command === "string" ? input.command : "Shell command";
    case "read_file":
    case "write_file":
    case "edit_file":
      return typeof input?.filePath === "string" ? trimPath(input.filePath, 48) : "File operation";
    case "web_search":
      return typeof input?.query === "string" ? input.query : "Web search";
    case "todo_write":
      return Array.isArray(input?.todos) ? `${input.todos.length} todos updated` : "Todo list update";
    case "mcp_generic":
      return typeof input?.server === "string" && typeof input?.tool === "string"
        ? `${input.server} · ${input.tool}`
        : "Connector action";
    case "subagent_task":
      return typeof input?.subagentType === "string" ? input.subagentType : "Subagent task";
    case "ask_user_question":
      return "Waiting for your response";
    case "exit_plan_mode":
      return "Plan review";
    default:
      return tool.toolKind ? titleCase(tool.toolKind) : "Tool event";
  }
}

function resolveToolBody(tool: ToolDescriptor) {
  const input = tool.input as Record<string, unknown> | undefined;
  switch (tool.toolKind) {
    case "bash":
      return typeof input?.command === "string" ? compactMultiline(input.command, 5) : null;
    case "write_file":
      return typeof input?.content === "string" ? compactMultiline(input.content, 7) : null;
    case "edit_file":
      if (typeof input?.oldString === "string" && typeof input?.newString === "string") {
        return `From\n${compactMultiline(input.oldString, 4)}\n\nTo\n${compactMultiline(input.newString, 4)}`;
      }
      return null;
    case "read_file":
      return typeof input?.filePath === "string" ? input.filePath : null;
    case "web_search":
      return typeof input?.query === "string" ? input.query : null;
    case "todo_write":
      return Array.isArray(input?.todos)
        ? input.todos
            .map((todo) => `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} ${todo.content}`)
            .join("\n")
        : null;
    case "ask_user_question":
      return Array.isArray(input?.questions)
        ? input.questions.map((question) => question.question).join("\n")
        : null;
    case "exit_plan_mode":
      return typeof input?.plan === "string" ? compactMultiline(input.plan, 8) : null;
    case "mcp_generic":
      return input?.payload ? compactMultiline(formatJson(input.payload), 7) : null;
    default:
      return input ? compactMultiline(formatJson(input), 7) : null;
  }
}

function resolveToolResultSummary(tool: ToolDescriptor | undefined, content: unknown) {
  const input = tool?.input as Record<string, unknown> | undefined;
  const record = asRecord(content);

  switch (tool?.toolKind) {
    case "bash": {
      const details = commandResultDetails(content);
      if (details.exitCode != null) {
        return details.exitCode === 0 ? "Command completed successfully" : `Command failed with exit code ${details.exitCode}`;
      }
      if (details.status) {
        return titleCase(details.status);
      }
      return "Command finished";
    }
    case "read_file":
      return typeof input?.filePath === "string" ? trimPath(input.filePath, 54) : "File contents loaded";
    case "write_file":
      return typeof input?.filePath === "string" ? `Wrote ${trimPath(input.filePath, 48)}` : "File written";
    case "edit_file":
      return typeof input?.filePath === "string" ? `Updated ${trimPath(input.filePath, 48)}` : "File updated";
    case "web_search":
      return typeof input?.query === "string" ? input.query : "Search completed";
    case "todo_write":
      return Array.isArray(input?.todos) ? `${input.todos.length} tasks updated` : "Todo list updated";
    case "ask_user_question":
      return "User input captured";
    case "mcp_generic":
      return typeof input?.server === "string" && typeof input?.tool === "string"
        ? `${input.server} · ${input.tool}`
        : "Connector response";
    default:
      if (typeof content === "string" && content.trim()) {
        return compactMultiline(content, 2);
      }
      if (record && typeof record.message === "string") {
        return record.message;
      }
      return "Tool completed";
  }
}

function resolveToolResultBody(tool: ToolDescriptor | undefined, content: unknown) {
  const input = tool?.input as Record<string, unknown> | undefined;
  const record = asRecord(content);

  switch (tool?.toolKind) {
    case "bash": {
      const details = commandResultDetails(content);
      return details.output ? compactMultiline(details.output, 12) : null;
    }
    case "read_file":
      if (typeof content === "string") return compactMultiline(content, 12);
      if (typeof record?.content === "string") return compactMultiline(record.content, 12);
      return null;
    case "edit_file":
    case "write_file": {
      const change = Array.isArray(record?.changes) ? record.changes[0] : null;
      if (change && typeof change === "object" && !Array.isArray(change)) {
        const diff = typeof (change as { diff?: unknown }).diff === "string" ? (change as { diff: string }).diff : null;
        if (diff) return compactMultiline(diff, 12);
      }
      if (tool?.toolKind === "write_file" && typeof input?.content === "string") {
        return compactMultiline(input.content, 10);
      }
      return null;
    }
    case "ask_user_question": {
      const answers = record?.answers;
      if (answers && typeof answers === "object" && !Array.isArray(answers)) {
        return compactMultiline(formatJson(answers), 10);
      }
      return null;
    }
    case "web_search":
    case "mcp_generic":
    case "unknown_tool":
      return compactMultiline(formatJson(content), 10);
    default:
      if (typeof content === "string") return compactMultiline(content, 10);
      return record ? compactMultiline(formatJson(record), 10) : null;
  }
}

function resolveToolResultMeta(tool: ToolDescriptor | undefined, content: unknown) {
  if (tool?.toolKind !== "bash") return [];
  const details = commandResultDetails(content);
  return [
    details.exitCode != null ? `exit ${details.exitCode}` : null,
    details.durationMs != null ? formatDuration(details.durationMs) : null,
    details.status ? titleCase(details.status) : null,
  ].filter((value): value is string => Boolean(value));
}

function toolChrome(toolKind: ToolDescriptor["toolKind"], palette: ReturnType<typeof createPalette>) {
  switch (toolKind) {
    case "bash":
      return { badge: "RUN", glyph: ">_", accent: palette.tagBlue, tint: "rgba(70,148,255,0.12)" };
    case "read_file":
      return { badge: "READ", glyph: "R", accent: palette.tagMint, tint: "rgba(55,210,195,0.12)" };
    case "write_file":
      return { badge: "WRITE", glyph: "W", accent: palette.tagPurple, tint: "rgba(131,110,255,0.12)" };
    case "edit_file":
      return { badge: "EDIT", glyph: "E", accent: palette.tagPurple, tint: "rgba(131,110,255,0.12)" };
    case "web_search":
      return { badge: "SEARCH", glyph: "/", accent: palette.accent, tint: palette.accentSoft };
    case "todo_write":
      return { badge: "PLAN", glyph: "+", accent: palette.tagMint, tint: "rgba(55,210,195,0.12)" };
    case "ask_user_question":
      return { badge: "INPUT", glyph: "?", accent: palette.dangerText, tint: palette.dangerBg };
    case "mcp_generic":
      return { badge: "APP", glyph: "@", accent: palette.tagBlue, tint: "rgba(70,148,255,0.12)" };
    case "subagent_task":
      return { badge: "AGENT", glyph: "A", accent: palette.tagPurple, tint: "rgba(131,110,255,0.12)" };
    case "exit_plan_mode":
      return { badge: "PLAN", glyph: "\u2713", accent: palette.successText, tint: palette.successBg };
    default:
      return { badge: "TOOL", glyph: "*", accent: palette.textMuted, tint: palette.surfaceMuted };
  }
}

function createPalette(mode: ThemeMode) {
  if (mode === "dark") {
    return {
      mode,
      background: "#0d0d10",
      canvas: "#141419",
      surface: "rgba(24, 24, 30, 0.94)",
      surfaceMuted: "rgba(29, 29, 37, 0.9)",
      surfaceStrong: "#1a1b21",
      cardBorder: "rgba(255,255,255,0.08)",
      borderSubtle: "rgba(255,255,255,0.06)",
      text: "#f7f4ef",
      textStrong: "#ffffff",
      textMuted: "#9b98a6",
      textSoft: "#7c7986",
      accent: "#5561ff",
      accentSoft: "rgba(85, 97, 255, 0.14)",
      accentText: "#e9ebff",
      successBg: "rgba(39, 88, 58, 0.16)",
      successText: "#95dea7",
      dangerBg: "rgba(133, 48, 48, 0.16)",
      dangerText: "#ffb8ae",
      incomingBg: "rgba(255,255,255,0.04)",
      outgoingBg: "#5561ff",
      outgoingText: "#f8f8ff",
      shadow: "0 18px 50px rgba(0,0,0,0.32)",
      keyboardBar: "#15161b",
      tagBlue: "#4f86ff",
      tagPurple: "#8166ff",
      tagMint: "#36c9bd",
    } as const;
  }

  return {
    mode,
    background: "#f4f2ee",
    canvas: "#fbfaf7",
    surface: "rgba(255, 255, 255, 0.9)",
    surfaceMuted: "rgba(255, 255, 255, 0.78)",
    surfaceStrong: "#ffffff",
    cardBorder: "rgba(17, 24, 39, 0.08)",
    borderSubtle: "rgba(17, 24, 39, 0.05)",
    text: "#121214",
    textStrong: "#000000",
    textMuted: "#74707d",
    textSoft: "#9a96a2",
    accent: "#5664ff",
    accentSoft: "rgba(86, 100, 255, 0.12)",
    accentText: "#eef0ff",
    successBg: "rgba(50, 185, 95, 0.14)",
    successText: "#19a34a",
    dangerBg: "rgba(255, 96, 77, 0.14)",
    dangerText: "#ff5a4e",
    incomingBg: "rgba(255,255,255,0.84)",
    outgoingBg: "#eef1fb",
    outgoingText: "#11131b",
    shadow: "0 22px 48px rgba(23, 28, 38, 0.08)",
    keyboardBar: "#fffefb",
    tagBlue: "#4694ff",
    tagPurple: "#836eff",
    tagMint: "#37d2c3",
  } as const;
}

type GlyphName =
  | "chevron-right"
  | "chevron-down"
  | "plus"
  | "arrow-up-right"
  | "arrow-down"
  | "close";

const GLYPHS: Record<GlyphName, string> = {
  "chevron-right": "\u203A",
  "chevron-down": "\u2304",
  plus: "+",
  "arrow-up-right": "\u2197",
  "arrow-down": "\u2193",
  close: "\u00D7",
};

function Glyph({
  name,
  size,
  color,
  weight = "700",
}: {
  name: GlyphName;
  size: number;
  color: string;
  weight?: "500" | "600" | "700" | "800" | "900";
}) {
  return (
    <Text
      style={{
        color,
        fontSize: size,
        fontWeight: weight,
        lineHeight: size + 2,
        includeFontPadding: false,
        textAlign: "center",
      }}>
      {GLYPHS[name]}
    </Text>
  );
}

function renderInlineSegments(text: string, palette: ReturnType<typeof createPalette>, keyPrefix: string) {
  return text.split(/(`[^`]+`)/g).map((segment, index) => {
    if (segment.startsWith("`") && segment.endsWith("`") && segment.length >= 2) {
      return (
        <Text
          key={`${keyPrefix}-${index}`}
          style={{
            fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
            fontSize: 14,
            color: palette.textStrong,
            backgroundColor: palette.surfaceMuted,
            paddingHorizontal: 5,
            paddingVertical: 1,
          }}>
          {segment.slice(1, -1)}
        </Text>
      );
    }
    return <Text key={`${keyPrefix}-${index}`}>{segment}</Text>;
  });
}

type AssistantBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string; level: number }
  | { type: "bullet"; text: string }
  | { type: "numbered"; text: string; marker: string }
  | { type: "code"; text: string };

function parseAssistantBlocks(text: string): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    const value = paragraph.join(" ").trim();
    if (value) blocks.push({ type: "paragraph", text: value });
    paragraph = [];
  };

  const flushCode = () => {
    const value = codeLines.join("\n").trimEnd();
    if (value) blocks.push({ type: "code", text: value });
    codeLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      if (inCodeBlock) flushCode();
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: headingMatch[1]?.length ?? 1,
        text: headingMatch[2]?.trim() ?? "",
      });
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({ type: "bullet", text: bulletMatch[1]?.trim() ?? "" });
      continue;
    }

    const numberedMatch = trimmed.match(/^(\d+\.)\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push({
        type: "numbered",
        marker: numberedMatch[1] ?? "1.",
        text: numberedMatch[2]?.trim() ?? "",
      });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  if (inCodeBlock) flushCode();

  return blocks;
}

function AssistantRichText({
  text,
  palette,
}: {
  text: string;
  palette: ReturnType<typeof createPalette>;
}) {
  const blocks = parseAssistantBlocks(text);

  return (
    <View style={{ gap: 12 }}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const size = block.level === 1 ? 21 : block.level === 2 ? 18 : 16;
          return (
            <Text
              key={`heading-${index}`}
              selectable
              style={{
                color: palette.textStrong,
                fontSize: size,
                lineHeight: size + 7,
                fontWeight: "800",
                letterSpacing: block.level === 1 ? -0.45 : -0.2,
              }}>
              {block.text}
            </Text>
          );
        }

        if (block.type === "bullet") {
          return (
            <View key={`bullet-${index}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <Text style={{ color: palette.textSoft, fontSize: 18, lineHeight: 24 }}>•</Text>
              <Text selectable style={{ flex: 1, color: palette.textStrong, fontSize: 16, lineHeight: 24 }}>
                {renderInlineSegments(block.text, palette, `bullet-${index}`)}
              </Text>
            </View>
          );
        }

        if (block.type === "numbered") {
          return (
            <View key={`numbered-${index}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <Text style={{ minWidth: 26, color: palette.textSoft, fontSize: 14, lineHeight: 24, fontWeight: "700" }}>{block.marker}</Text>
              <Text selectable style={{ flex: 1, color: palette.textStrong, fontSize: 16, lineHeight: 24 }}>
                {renderInlineSegments(block.text, palette, `numbered-${index}`)}
              </Text>
            </View>
          );
        }

        if (block.type === "code") {
          return (
            <View
              key={`code-${index}`}
              style={{
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: palette.surfaceMuted,
                paddingHorizontal: 14,
                paddingVertical: 13,
              }}>
              <Text
                selectable
                style={{
                  color: palette.textMuted,
                  fontSize: 13,
                  lineHeight: 20,
                  fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
                }}>
                {block.text}
              </Text>
            </View>
          );
        }

        return (
          <Text
            key={`paragraph-${index}`}
            selectable
            style={{
              color: palette.textStrong,
              fontSize: 16,
              lineHeight: 25,
              letterSpacing: -0.1,
            }}>
            {renderInlineSegments(block.text, palette, `paragraph-${index}`)}
          </Text>
        );
      })}
    </View>
  );
}

function ChromeButton({
  label,
  palette,
  onPress,
  compact = false,
}: {
  label: string;
  palette: ReturnType<typeof createPalette>;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        minWidth: compact ? 44 : 54,
        height: compact ? 44 : 52,
        borderRadius: compact ? 22 : 26,
        borderCurve: "continuous",
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.cardBorder,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: compact ? 12 : 16,
        boxShadow: palette.shadow,
      }}>
      <Text style={{ color: palette.textStrong, fontSize: compact ? 13 : 14, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

function StatPill({
  primary,
  secondary,
  palette,
}: {
  primary: string;
  secondary: string;
  palette: ReturnType<typeof createPalette>;
}) {
  return (
    <View
      style={{
        minHeight: 52,
        borderRadius: 26,
        borderCurve: "continuous",
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.cardBorder,
        paddingHorizontal: 16,
        justifyContent: "center",
        boxShadow: palette.shadow,
      }}>
      <Text style={{ color: palette.successText, fontSize: 15, fontWeight: "800" }}>{primary}</Text>
      <Text style={{ color: palette.dangerText, fontSize: 11, fontWeight: "700", marginTop: -1 }}>{secondary}</Text>
    </View>
  );
}

function SelectorPill({
  label,
  value,
  palette,
  onPress,
  compact = false,
  showLabel = true,
}: {
  label: string;
  value: string;
  palette: ReturnType<typeof createPalette>;
  onPress: () => void;
  compact?: boolean;
  showLabel?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        minWidth: compact ? 74 : 104,
        maxWidth: compact ? 96 : undefined,
        minHeight: compact ? 34 : undefined,
        borderRadius: compact ? 18 : 22,
        borderCurve: "continuous",
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.cardBorder,
        paddingHorizontal: compact ? 10 : 14,
        paddingVertical: compact ? 5 : 9,
        gap: showLabel ? 2 : 0,
        boxShadow: palette.shadow,
        justifyContent: "center",
        flexShrink: compact ? 1 : 0,
      }}>
      {showLabel ? (
        <Text style={{ color: palette.textSoft, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.7 }}>
          {label}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={{ color: palette.textStrong, fontSize: compact ? 12 : 15, fontWeight: "700" }}>
        {value}
      </Text>
    </Pressable>
  );
}

function EmptyState({
  palette,
  provider,
  model,
}: {
  palette: ReturnType<typeof createPalette>;
  provider: AgentProvider;
  model: string;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 42,
        gap: 16,
      }}>
      <View
        style={{
          width: 84,
          height: 84,
          borderRadius: 28,
          borderCurve: "continuous",
          backgroundColor: palette.surface,
          borderWidth: 1,
          borderColor: palette.cardBorder,
          alignItems: "center",
          justifyContent: "center",
          boxShadow: palette.shadow,
        }}>
        <View
          style={{
            width: 54,
            height: 54,
            borderRadius: 27,
            borderCurve: "continuous",
            backgroundColor: palette.accent,
            alignItems: "center",
            justifyContent: "center",
          }}>
          <Text style={{ color: "#ffffff", fontSize: 22, fontWeight: "800" }}>{">_"}</Text>
        </View>
      </View>
      <View style={{ alignItems: "center", gap: 6 }}>
        <Text selectable style={{ color: palette.textStrong, fontSize: 28, fontWeight: "800" }}>
          Pick a folder.
        </Text>
        <Text selectable style={{ color: palette.textMuted, fontSize: 15 }}>
          Open the drawer, choose a project, then send a prompt to your Mac.
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
        <View
          style={{
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: palette.accentSoft,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}>
          <Text style={{ color: palette.accent, fontSize: 13, fontWeight: "700" }}>Folders + threads</Text>
        </View>
        <View
          style={{
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}>
          <Text style={{ color: palette.textMuted, fontSize: 13, fontWeight: "700" }}>Model switcher</Text>
        </View>
        <View
          style={{
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}>
          <Text style={{ color: palette.textMuted, fontSize: 13, fontWeight: "700" }}>Live sync</Text>
        </View>
      </View>
    </View>
  );
}

function MessageCard({
  entry,
  palette,
  relatedTool,
}: {
  entry: TranscriptEntry;
  palette: ReturnType<typeof createPalette>;
  relatedTool?: ToolDescriptor;
}) {
  const [expanded, setExpanded] = useState(() => {
    if (entry.kind === "tool_call" && "tool" in entry) {
      return entry.tool.toolKind === "ask_user_question" || entry.tool.toolKind === "exit_plan_mode";
    }
    return false;
  });

  if (entry.hidden) return null;

  if (entry.kind === "system_init" && "provider" in entry && "model" in entry && "tools" in entry && "agents" in entry) {
    return (
      <View
        style={{
          borderRadius: 24,
          borderCurve: "continuous",
          backgroundColor: palette.surface,
          borderWidth: 1,
          borderColor: palette.cardBorder,
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 8,
          boxShadow: palette.shadow,
        }}>
        <Text style={{ color: palette.textSoft, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 }}>
          Session
        </Text>
        <Text selectable style={{ color: palette.textStrong, fontSize: 17, fontWeight: "800" }}>
          {titleCase(entry.provider)} · {formatModelLabel(entry.model)}
        </Text>
        <Text selectable style={{ color: palette.textMuted, fontSize: 14, lineHeight: 20 }}>
          {entry.tools.length} tools · {entry.agents.length} agent actions
        </Text>
      </View>
    );
  }

  if (entry.kind === "user_prompt" && "content" in entry) {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "88%", gap: 6 }}>
        <View
          style={{
            borderRadius: 28,
            borderCurve: "continuous",
            backgroundColor: palette.outgoingBg,
            paddingHorizontal: 18,
            paddingVertical: 13,
            boxShadow: palette.shadow,
          }}>
          <Text selectable style={{ color: palette.outgoingText, fontSize: 16, lineHeight: 23 }}>
            {entry.content}
          </Text>
        </View>
        <Text selectable style={{ color: palette.textSoft, fontSize: 12, textAlign: "right" }}>
          {formatTimestamp(entry.createdAt)}
        </Text>
      </View>
    );
  }

  if (entry.kind === "assistant_text" && "text" in entry) {
    return (
      <View style={{ alignSelf: "stretch", gap: 8 }}>
        <View
          style={{
            borderRadius: 26,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            paddingHorizontal: 18,
            paddingVertical: 17,
            gap: 10,
          }}>
          <AssistantRichText text={entry.text} palette={palette} />
        </View>
        <Text selectable style={{ color: palette.textSoft, fontSize: 12 }}>
          {formatTimestamp(entry.createdAt)}
        </Text>
      </View>
    );
  }

  if (entry.kind === "tool_call" && "tool" in entry) {
    const summary = resolveToolSummary(entry.tool);
    const body = resolveToolBody(entry.tool);
    const chrome = toolChrome(entry.tool.toolKind, palette);
    const mono = entry.tool.toolKind === "bash" || entry.tool.toolKind === "read_file" || entry.tool.toolKind === "edit_file" || entry.tool.toolKind === "write_file";
    const canExpand = Boolean(body);
    return (
      <Pressable
        onPress={canExpand ? () => setExpanded((current) => !current) : undefined}
        style={{
          paddingVertical: 10,
          gap: 10,
        }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 12,
              backgroundColor: chrome.tint,
              alignItems: "center",
              justifyContent: "center",
              marginTop: 3,
            }}>
            <Text style={{ color: chrome.accent, fontSize: 12, fontWeight: "900", letterSpacing: -0.3 }}>{chrome.glyph}</Text>
          </View>
          <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: chrome.tint,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                }}>
                <Text style={{ color: chrome.accent, fontSize: 10, fontWeight: "800", letterSpacing: 0.6 }}>{chrome.badge}</Text>
              </View>
              <Text style={{ color: palette.textSoft, fontSize: 11, fontWeight: "700" }}>{formatTimestamp(entry.createdAt)}</Text>
            </View>
            <Text selectable style={{ color: palette.textStrong, fontSize: 15, fontWeight: "800" }}>
              {resolveToolTitle(entry.tool)}
            </Text>
            <Text
              selectable
              numberOfLines={expanded ? undefined : 2}
              style={{
                color: palette.textMuted,
                fontSize: 13,
                lineHeight: 19,
                fontFamily: mono ? Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) : undefined,
              }}>
              {summary}
            </Text>
          </View>
            {canExpand ? (
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: palette.surfaceMuted,
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 3,
              }}>
                <Glyph name={expanded ? "chevron-down" : "chevron-right"} size={14} color={palette.textSoft} />
              </View>
            ) : null}
        </View>
        {body && expanded ? (
          <View
            style={{
              marginLeft: 44,
              borderRadius: 18,
              borderCurve: "continuous",
              backgroundColor: palette.surfaceMuted,
              paddingHorizontal: 14,
              paddingVertical: 13,
            }}>
            <Text
              selectable
              style={{
                color: palette.textMuted,
                fontSize: 12,
                lineHeight: 18,
                fontFamily: mono ? Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) : undefined,
              }}>
              {body}
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  }

  if (entry.kind === "tool_result" && "content" in entry) {
    const summary = resolveToolResultSummary(relatedTool, entry.content);
    const body = resolveToolResultBody(relatedTool, entry.content);
    const meta = resolveToolResultMeta(relatedTool, entry.content);
    const chrome = toolChrome(relatedTool?.toolKind, palette);
    const mono = relatedTool?.toolKind === "bash" || relatedTool?.toolKind === "read_file" || relatedTool?.toolKind === "edit_file" || relatedTool?.toolKind === "write_file";
    const canExpand = Boolean(body);
    return (
      <Pressable
        onPress={canExpand ? () => setExpanded((current) => !current) : undefined}
        style={{
          marginLeft: 44,
          marginTop: -2,
          paddingBottom: 10,
          gap: 8,
        }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              borderRadius: 999,
              backgroundColor: chrome.tint,
              paddingHorizontal: 8,
              paddingVertical: 4,
            }}>
            <Text style={{ color: chrome.accent, fontSize: 10, fontWeight: "800", letterSpacing: 0.6 }}>RESULT</Text>
          </View>
          <Text style={{ color: palette.textSoft, fontSize: 11, fontWeight: "700" }}>{formatTimestamp(entry.createdAt)}</Text>
          {canExpand ? (
            <View style={{ marginLeft: "auto" }}>
              <Glyph name={expanded ? "chevron-down" : "chevron-right"} size={14} color={palette.textSoft} />
            </View>
          ) : null}
        </View>
        <Text
          selectable
          numberOfLines={expanded ? undefined : 3}
          style={{
            color: palette.textStrong,
            fontSize: 14,
            fontWeight: "700",
            lineHeight: 20,
            fontFamily: mono ? Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) : undefined,
          }}>
          {summary}
        </Text>
        {meta.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {meta.map((item) => (
              <View
                key={item}
                style={{
                  borderRadius: 999,
                  borderCurve: "continuous",
                  backgroundColor: palette.surface,
                  borderWidth: 1,
                  borderColor: palette.cardBorder,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                }}>
                <Text style={{ color: palette.textMuted, fontSize: 11, fontWeight: "700" }}>{item}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {body && expanded ? (
          <View
            style={{
              borderRadius: 18,
              borderCurve: "continuous",
              backgroundColor: palette.surfaceMuted,
              paddingHorizontal: 14,
              paddingVertical: 13,
            }}>
            <Text
              selectable
              style={{
                color: palette.textMuted,
                fontSize: 12,
                lineHeight: 18,
                fontFamily: mono ? Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) : undefined,
              }}>
              {body}
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  }

  if (entry.kind === "account_info" && "accountInfo" in entry) {
    return (
      <View
        style={{
          borderRadius: 22,
          borderCurve: "continuous",
          backgroundColor: palette.surface,
          borderWidth: 1,
          borderColor: palette.cardBorder,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}>
        <Text style={{ color: palette.textSoft, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
          Account
        </Text>
        <Text selectable style={{ color: palette.textMuted, fontSize: 13, lineHeight: 20 }}>
          {compactMultiline(formatJson(entry.accountInfo), 8)}
        </Text>
      </View>
    );
  }

  if (entry.kind === "status" && "status" in entry) {
    return (
      <View style={{ alignItems: "center" }}>
        <View
          style={{
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}>
          <Text selectable style={{ color: palette.textMuted, fontSize: 13, fontWeight: "700" }}>
            {formatStatus(entry.status)}
          </Text>
        </View>
      </View>
    );
  }

  if (entry.kind === "result" && "result" in entry && "subtype" in entry) {
    const isError = entry.subtype === "error";
    return (
      <View
        style={{
          borderRadius: 24,
          borderCurve: "continuous",
          backgroundColor: isError ? palette.dangerBg : palette.successBg,
          borderWidth: 1,
          borderColor: isError ? "rgba(255,90,78,0.24)" : "rgba(25,163,74,0.24)",
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}>
        <Text selectable style={{ color: isError ? palette.dangerText : palette.successText, fontSize: 14, lineHeight: 22 }}>
          {entry.result}
        </Text>
      </View>
    );
  }

  if (entry.kind === "compact_summary" && "summary" in entry) {
    return (
      <View
        style={{
          borderRadius: 22,
          borderCurve: "continuous",
          backgroundColor: palette.surfaceMuted,
          borderWidth: 1,
          borderColor: palette.cardBorder,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}>
        <Text style={{ color: palette.textSoft, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
          Context Summary
        </Text>
        <Text selectable style={{ color: palette.textMuted, fontSize: 14, lineHeight: 21 }}>
          {entry.summary}
        </Text>
      </View>
    );
  }

  if (entry.kind === "compact_boundary" || entry.kind === "context_cleared" || entry.kind === "interrupted") {
    const label =
      entry.kind === "compact_boundary"
        ? "Context compacted"
        : entry.kind === "context_cleared"
          ? "Context cleared"
          : "Turn interrupted";
    return (
      <View style={{ alignItems: "center" }}>
        <View
          style={{
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}>
          <Text selectable style={{ color: palette.textMuted, fontSize: 13, fontWeight: "700" }}>
            {label}
          </Text>
        </View>
      </View>
    );
  }

  return null;
}

function ChatRow({
  chat,
  selected,
  palette,
  onPress,
}: {
  chat: SidebarChatRow;
  selected: boolean;
  palette: ReturnType<typeof createPalette>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: 18,
        borderCurve: "continuous",
        backgroundColor: selected ? palette.surfaceMuted : "transparent",
        paddingHorizontal: 10,
        paddingVertical: 9,
      }}>
      <View
        style={{
          marginTop: 5,
          width: 8,
          height: 8,
          borderRadius: 999,
          backgroundColor: selected ? palette.accent : palette.borderSubtle,
        }}
      />
      <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text
            selectable
            numberOfLines={1}
            style={{ flex: 1, color: palette.textStrong, fontSize: 15, fontWeight: selected ? "700" : "600" }}>
            {chat.title}
          </Text>
          {chat.lastMessageAt ? (
            <Text selectable style={{ color: palette.textSoft, fontSize: 11, fontWeight: "600" }}>
              {formatTimestamp(chat.lastMessageAt)}
            </Text>
          ) : null}
        </View>
        <Text selectable numberOfLines={1} style={{ color: palette.textMuted, fontSize: 12 }}>
          {chat.provider ?? "unknown"} · {formatStatus(chat.status)}
        </Text>
      </View>
    </Pressable>
  );
}

function ProjectSection({
  group,
  activeChatId,
  palette,
  collapsed,
  onToggleCollapse,
  onSelectProject,
  onSelectChat,
}: {
  group: SidebarProjectGroup;
  activeChatId: string | null;
  palette: ReturnType<typeof createPalette>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectChat: (chatId: string, projectId: string) => void;
}) {
  const folderName = group.localPath.split("/").pop() || group.localPath;

  return (
    <View
      style={{
        gap: 10,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: palette.borderSubtle,
      }}>
      <Pressable
        onPress={() => {
          onSelectProject(group.groupKey);
          onToggleCollapse();
        }}
        style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Glyph name={collapsed ? "chevron-right" : "chevron-down"} size={18} color={palette.textSoft} />
          <Text selectable numberOfLines={1} style={{ flex: 1, color: palette.textStrong, fontSize: 18, fontWeight: "800" }}>
            {folderName}
          </Text>
          <Text style={{ color: palette.textSoft, fontSize: 11, fontWeight: "700" }}>{group.chats.length}</Text>
        </View>
        <View style={{ paddingLeft: 26, gap: 3 }}>
          <Text selectable numberOfLines={1} style={{ color: palette.textMuted, fontSize: 12 }}>
            {trimPath(group.localPath, 34)}
          </Text>
          <Text style={{ color: palette.textSoft, fontSize: 11, fontWeight: "600" }}>
            {collapsed ? "Tap to open thread list" : "Tap to collapse"}
          </Text>
        </View>
      </Pressable>

      {!collapsed ? (
        <View
          style={{
            marginLeft: 8,
            paddingLeft: 18,
            borderLeftWidth: 1,
            borderLeftColor: palette.borderSubtle,
            gap: 2,
          }}>
          {group.chats.map((chat) => (
            <ChatRow
              key={chat.chatId}
              chat={chat}
              selected={activeChatId === chat.chatId}
              palette={palette}
              onPress={() => onSelectChat(chat.chatId, group.groupKey)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SelectionSheet({
  open,
  title,
  palette,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  palette: ReturnType<typeof createPalette>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: palette.mode === "dark" ? "rgba(0,0,0,0.34)" : "rgba(18,18,24,0.18)",
          justifyContent: "flex-end",
        }}>
        <Pressable
          onPress={() => {}}
          style={{
            borderTopLeftRadius: 30,
            borderTopRightRadius: 30,
            borderCurve: "continuous",
            backgroundColor: palette.canvas,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 18,
            paddingTop: 18,
            paddingBottom: 28,
            gap: 14,
          }}>
          <View style={{ alignItems: "center" }}>
            <View
              style={{
                width: 54,
                height: 5,
                borderRadius: 999,
                backgroundColor: palette.borderSubtle,
              }}
            />
          </View>
          <Text style={{ color: palette.textStrong, fontSize: 24, fontWeight: "800" }}>{title}</Text>
          <ScrollView contentContainerStyle={{ gap: 10 }}>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ChoiceRow({
  title,
  subtitle,
  selected,
  palette,
  onPress,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  palette: ReturnType<typeof createPalette>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderRadius: 22,
        borderCurve: "continuous",
        backgroundColor: selected ? palette.accentSoft : palette.surface,
        borderWidth: 1,
        borderColor: selected ? "rgba(86,100,255,0.18)" : palette.cardBorder,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 5,
      }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: palette.textStrong, fontSize: 17, fontWeight: "700" }}>{title}</Text>
        {selected ? <Text style={{ color: palette.accent, fontSize: 13, fontWeight: "800" }}>Selected</Text> : null}
      </View>
      <Text style={{ color: palette.textMuted, fontSize: 13, lineHeight: 18 }}>{subtitle}</Text>
    </Pressable>
  );
}

export function PhoenixMobileShell() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const drawerRef = useRef<DrawerLayoutAndroid>(null);
  const transcriptRef = useRef<ScrollView>(null);

  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [model, setModel] = useState("gpt-5.4");
  const [effort, setEffort] = useState("high");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_URL);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [sending, setSending] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [androidKeyboardHeight, setAndroidKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setAndroidKeyboardHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setAndroidKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const palette = useMemo(() => createPalette(themeMode), [themeMode]);
  const { status, sidebar, chat, error, setError, sendCommand } = usePhoenixClient(serverUrl, activeChatId);
  const availableProviders = useMemo(() => getActiveProviders(chat?.availableProviders), [chat?.availableProviders]);
  const selectedProviderConfig = useMemo(
    () => getCatalogProvider(availableProviders, provider),
    [availableProviders, provider]
  );
  const effortChoices = useMemo(
    () => getEffortChoices(provider, selectedProviderConfig.id === provider ? selectedProviderConfig : undefined),
    [provider, selectedProviderConfig]
  );

  useEffect(() => {
    const models = selectedProviderConfig?.models?.map((entry) => entry.id) ?? getProviderModels(provider);
    if (!models.includes(model)) {
      setModel(models[0] ?? "");
    }
  }, [model, provider, selectedProviderConfig]);

  useEffect(() => {
    if (!effortChoices.some((candidate) => candidate.id === effort)) {
      setEffort(selectedProviderConfig?.defaultEffort ?? effortChoices[2]?.id ?? effortChoices[0]?.id ?? "high");
    }
  }, [effort, effortChoices, selectedProviderConfig]);

  useEffect(() => {
    if (!selectedProjectId && sidebar.projectGroups[0]) {
      setSelectedProjectId(sidebar.projectGroups[0].groupKey);
    }
  }, [selectedProjectId, sidebar.projectGroups]);

  useEffect(() => {
    setCollapsedGroups((current) => {
      let changed = false;
      const next = { ...current };
      for (const group of sidebar.projectGroups) {
        if (!(group.groupKey in next)) {
          next[group.groupKey] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sidebar.projectGroups]);

  const activeProject = useMemo(() => {
    return sidebar.projectGroups.find((group) => group.groupKey === selectedProjectId) ?? sidebar.projectGroups[0] ?? null;
  }, [selectedProjectId, sidebar.projectGroups]);

  const allVisibleMessages = useMemo(() => {
    return (chat?.messages ?? []).filter((entry) => !entry.hidden);
  }, [chat?.messages]);

  const visibleMessages = useMemo(() => {
    return allVisibleMessages.slice(-60);
  }, [allVisibleMessages]);
  const toolsById = useMemo(() => {
    const next = new Map<string, ToolDescriptor>();
    for (const entry of allVisibleMessages) {
      if (entry.kind === "tool_call" && "tool" in entry && entry.tool.toolId) {
        next.set(entry.tool.toolId, entry.tool);
      }
    }
    return next;
  }, [allVisibleMessages]);

  const hiddenMessageCount = allVisibleMessages.length - visibleMessages.length;
  const composerBottomInset = insets.bottom + 12;
  const transcriptBottomInset = composerBottomInset + 146;
  const showScrollToBottom = !!chat && !isNearBottom;

  const filteredGroups = useMemo(() => {
    const query = sidebarQuery.trim().toLowerCase();
    if (!query) return sidebar.projectGroups;

    return sidebar.projectGroups
      .map((group) => {
        const folderMatch = group.localPath.toLowerCase().includes(query);
        if (folderMatch) return group;
        const chats = group.chats.filter((chatRow) => chatRow.title.toLowerCase().includes(query));
        return chats.length ? { ...group, chats } : null;
      })
      .filter((group): group is SidebarProjectGroup => Boolean(group));
  }, [sidebar.projectGroups, sidebarQuery]);

  async function handleSend() {
    const content = composerValue.trim();
    if (!content || sending) return;
    const projectId = chat?.runtime.projectId ?? selectedProjectId ?? activeProject?.groupKey ?? null;
    if (!projectId) {
      setError("Pick a folder before sending a message");
      return;
    }

    setSending(true);
    setError(null);
    try {
      if (attachments.length > 0) {
        setError("Attachment picking is ready, but Phoenix still needs backend support to send files and photos.");
      }
      const result = await sendCommand({
        type: "chat.send",
        chatId: chat?.runtime.chatId,
        projectId,
        provider,
        model,
        effort,
        content,
      });
      const nextChatId =
        typeof result === "object" && result && "chatId" in result && typeof result.chatId === "string"
          ? result.chatId
          : null;
      if (nextChatId) {
        setActiveChatId(nextChatId);
      }
      setComposerValue("");
      setAttachments([]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  }

  async function handleCancel() {
    if (!chat?.runtime.chatId || sending) return;
    setSending(true);
    try {
      await sendCommand({
        type: "chat.cancel",
        chatId: chat.runtime.chatId,
      });
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setSending(false);
    }
  }

  async function handlePickDocument() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      const next = result.assets.map((asset) => ({
        id: `${asset.uri}-${asset.name}`,
        name: asset.name,
        kind: "file" as const,
      }));
      setAttachments((current) => [...current, ...next]);
      setSheet(null);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  }

  async function handlePickImage(source: "library" | "camera") {
    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError("Camera permission is required to take a photo.");
          return;
        }
        const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
        if (result.canceled) return;
        setAttachments((current) => [
          ...current,
          ...result.assets.map((asset) => ({
            id: asset.uri,
            name: asset.fileName ?? "camera-image.jpg",
            kind: "image" as const,
          })),
        ]);
        setSheet(null);
        return;
      }

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError("Photo library permission is required to choose an image.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.8 });
      if (result.canceled) return;
      setAttachments((current) => [
        ...current,
        ...result.assets.map((asset) => ({
          id: asset.uri,
          name: asset.fileName ?? "image.jpg",
          kind: "image" as const,
        })),
      ]);
      setSheet(null);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  }

  function toggleGroup(groupKey: string) {
    setCollapsedGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey],
    }));
  }

  function scrollTranscriptToBottom(animated = true) {
    transcriptRef.current?.scrollToEnd({ animated });
  }

  function handleTranscriptScroll(event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    setIsNearBottom(distanceFromBottom < 56);
  }

  useEffect(() => {
    if (isNearBottom) {
      scrollTranscriptToBottom(false);
    }
  }, [activeChatId, isNearBottom]);

  useEffect(() => {
    if (isNearBottom) {
      scrollTranscriptToBottom(true);
    }
  }, [isNearBottom, visibleMessages.length]);

  function navigationView() {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: palette.canvas }}
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 26,
          paddingHorizontal: 16,
          gap: 16,
        }}>
        <View
          style={{
            paddingTop: 6,
            paddingBottom: 10,
            gap: 10,
            borderBottomWidth: 1,
            borderBottomColor: palette.borderSubtle,
          }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: palette.textStrong, fontSize: 28, fontWeight: "900", letterSpacing: -0.9 }}>Phoenix</Text>
              <Text style={{ color: palette.textMuted, fontSize: 13 }}>
                Projects and chats on your Mac
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 5 }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  backgroundColor: status === "connected" ? palette.successText : palette.dangerText,
                }}
              />
              <Text style={{ color: palette.textSoft, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.7 }}>
                {sidebar.projectGroups.length} folders
              </Text>
            </View>
          </View>
        </View>

        <View
          style={{
            gap: 10,
            paddingBottom: 14,
            borderBottomWidth: 1,
            borderBottomColor: palette.borderSubtle,
          }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ color: palette.textSoft, fontSize: 11, textTransform: "uppercase", fontWeight: "700", letterSpacing: 0.8 }}>
              Server
            </Text>
            <Pressable
              onPress={() => {
                setServerUrl(serverInput.trim());
                setError(null);
              }}
              style={{
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: palette.accent,
                paddingHorizontal: 12,
                paddingVertical: 7,
              }}>
              <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "800" }}>Reconnect</Text>
            </Pressable>
          </View>
          <TextInput
            value={serverInput}
            onChangeText={setServerInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://192.168.x.x:3210"
            placeholderTextColor={palette.textMuted}
            style={{
              backgroundColor: palette.surface,
              borderRadius: 16,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: palette.cardBorder,
              color: palette.textStrong,
              paddingHorizontal: 14,
              paddingVertical: 11,
              fontSize: 14,
            }}
          />
          <Text style={{ color: palette.textSoft, fontSize: 11 }}>
            {status === "connected" ? "Connected over your current network." : "Connection lost. Reconnect after editing the server URL."}
          </Text>
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            borderRadius: 18,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 14,
            paddingVertical: 11,
          }}>
          <TextInput
            value={sidebarQuery}
            onChangeText={setSidebarQuery}
            placeholder="Search folders and chats"
            placeholderTextColor={palette.textSoft}
            style={{
              flex: 1,
              color: palette.textStrong,
              fontSize: 15,
            }}
          />
        </View>

        <Pressable
          onPress={() => {
            setActiveChatId(null);
            drawerRef.current?.closeDrawer();
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderRadius: 18,
            borderCurve: "continuous",
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.cardBorder,
            paddingHorizontal: 14,
            paddingVertical: 13,
          }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                backgroundColor: palette.accentSoft,
              alignItems: "center",
              justifyContent: "center",
            }}>
              <Glyph name="plus" size={18} color={palette.accent} />
            </View>
            <View style={{ gap: 2 }}>
              <Text style={{ color: palette.textStrong, fontSize: 16, fontWeight: "800" }}>New chat</Text>
              <Text style={{ color: palette.textMuted, fontSize: 12 }}>Start fresh in the selected folder.</Text>
            </View>
          </View>
          <Glyph name="arrow-up-right" size={15} color={palette.textSoft} />
        </Pressable>

        <View style={{ gap: 12 }}>
          <Text style={{ color: palette.textSoft, fontSize: 11, textTransform: "uppercase", fontWeight: "700", letterSpacing: 0.8 }}>
            Folders
          </Text>
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: palette.borderSubtle,
              gap: 14,
              paddingTop: 8,
            }}>
            {filteredGroups.map((group) => (
              <ProjectSection
                key={group.groupKey}
                group={group}
                activeChatId={activeChatId}
                palette={palette}
                collapsed={Boolean(collapsedGroups[group.groupKey])}
                onToggleCollapse={() => toggleGroup(group.groupKey)}
                onSelectProject={(projectId) => {
                  setSelectedProjectId(projectId);
                }}
                onSelectChat={(chatId, projectId) => {
                  setSelectedProjectId(projectId);
                  setActiveChatId(chatId);
                  drawerRef.current?.closeDrawer();
                }}
              />
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <>
      <StatusBar style={themeMode === "dark" ? "light" : "dark"} />
      <DrawerLayoutAndroid
        ref={drawerRef}
        drawerWidth={Math.min(390, Math.max(320, width * 0.86))}
        drawerPosition="left"
        renderNavigationView={navigationView}>
        <KeyboardAvoidingView
          enabled={Platform.OS === "ios"}
          behavior="padding"
          keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
          style={{ flex: 1, backgroundColor: palette.background }}>
          <View
            style={{
              position: "relative",
              flex: 1,
              paddingTop: insets.top + 10,
              paddingBottom: Platform.OS === "android" ? androidKeyboardHeight : 0,
              paddingHorizontal: 16,
              gap: 14,
            }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <ChromeButton label="Menu" palette={palette} onPress={() => drawerRef.current?.openDrawer()} compact />
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={1} style={{ color: palette.textStrong, fontSize: 19, fontWeight: "800" }}>
                  {chat?.runtime.title ?? "Conversation"}
                </Text>
                <Text numberOfLines={1} style={{ color: palette.textMuted, fontSize: 13 }}>
                  {trimPath(chat?.runtime.localPath ?? activeProject?.localPath ?? serverUrl, 34)}
                </Text>
              </View>
              {chat?.runtime.status === "running" || chat?.runtime.status === "starting" || chat?.runtime.status === "waiting_for_user" ? (
                <Pressable
                  onPress={() => void handleCancel()}
                  style={{
                    minWidth: 52,
                    height: 44,
                    borderRadius: 22,
                    borderCurve: "continuous",
                    backgroundColor: palette.surface,
                    borderWidth: 1,
                    borderColor: "rgba(255,90,78,0.22)",
                    alignItems: "center",
                    justifyContent: "center",
                    paddingHorizontal: 14,
                    boxShadow: palette.shadow,
                  }}>
                  <Text style={{ color: palette.dangerText, fontSize: 12, fontWeight: "800" }}>Stop</Text>
                </Pressable>
              ) : null}
              <ChromeButton label="Theme" palette={palette} onPress={() => setSheet("theme")} compact />
              <StatPill
                primary={`+${visibleMessages.filter((entry) => entry.kind === "assistant_text").length}`}
                secondary={`-${visibleMessages.filter((entry) => entry.kind === "user_prompt").length}`}
                palette={palette}
              />
            </View>

            {error ? (
              <View
                style={{
                  borderRadius: 22,
                  borderCurve: "continuous",
                  backgroundColor: palette.dangerBg,
                  borderWidth: 1,
                  borderColor: "rgba(255,90,78,0.24)",
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                }}>
                <Text selectable style={{ color: palette.dangerText, fontSize: 14, lineHeight: 20 }}>
                  {error}
                </Text>
              </View>
            ) : null}

            {hiddenMessageCount > 0 ? (
              <View
                style={{
                  borderRadius: 18,
                  borderCurve: "continuous",
                  backgroundColor: palette.surface,
                  borderWidth: 1,
                  borderColor: palette.cardBorder,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}>
                <Text style={{ color: palette.textMuted, fontSize: 13, lineHeight: 18 }}>
                  Showing the latest {visibleMessages.length} messages for speed.
                </Text>
              </View>
            ) : null}

            <ScrollView
              ref={transcriptRef}
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={16}
              onScroll={handleTranscriptScroll}
              style={{ flex: 1 }}
              scrollIndicatorInsets={{ bottom: transcriptBottomInset }}
              contentContainerStyle={{
                gap: 16,
                paddingBottom: transcriptBottomInset,
              }}>
              {!chat ? <EmptyState palette={palette} provider={provider} model={model} /> : null}
              {visibleMessages.map((entry) => (
                <MessageCard
                  key={entry._id}
                  entry={entry}
                  palette={palette}
                  relatedTool={entry.kind === "tool_result" && "toolId" in entry ? toolsById.get(entry.toolId) : undefined}
                />
              ))}
            </ScrollView>

            {showScrollToBottom ? (
              <Pressable
                onPress={() => scrollTranscriptToBottom(true)}
                style={{
                  position: "absolute",
                  right: 28,
                  bottom: composerBottomInset + 118 + (Platform.OS === "android" ? androidKeyboardHeight : 0),
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  borderCurve: "continuous",
                  backgroundColor: palette.surfaceStrong,
                  borderWidth: 1,
                  borderColor: palette.cardBorder,
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: palette.shadow,
                  zIndex: 24,
                  elevation: 8,
                }}>
                <Glyph name="arrow-down" size={18} color={palette.textStrong} />
              </Pressable>
            ) : null}

            <View
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                bottom: composerBottomInset + (Platform.OS === "android" ? androidKeyboardHeight : 0),
                borderRadius: 30,
                borderCurve: "continuous",
                backgroundColor: palette.keyboardBar,
                borderWidth: 1,
                borderColor: palette.cardBorder,
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 10,
                gap: 8,
                boxShadow: palette.shadow,
                zIndex: 20,
                elevation: 10,
                overflow: "hidden",
              }}>
              {attachments.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {attachments.map((attachment) => (
                    <Pressable
                      key={attachment.id}
                      onPress={() => {
                        setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));
                      }}
                      style={{
                        borderRadius: 999,
                        borderCurve: "continuous",
                        backgroundColor: attachment.kind === "image" ? palette.accentSoft : palette.surface,
                        borderWidth: 1,
                        borderColor: palette.cardBorder,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                      }}>
                      <View
                        style={{
                          borderRadius: 999,
                          backgroundColor: attachment.kind === "image" ? palette.accentSoft : palette.surfaceMuted,
                          paddingHorizontal: 6,
                          paddingVertical: 3,
                        }}>
                        <Text
                          style={{
                            color: attachment.kind === "image" ? palette.accent : palette.textMuted,
                            fontSize: 10,
                            fontWeight: "800",
                            letterSpacing: 0.3,
                          }}>
                          {attachment.kind === "image" ? "IMG" : "FILE"}
                        </Text>
                      </View>
                      <Text numberOfLines={1} style={{ maxWidth: 170, color: palette.textStrong, fontSize: 13, fontWeight: "600" }}>
                        {attachment.name}
                      </Text>
                      <Glyph name="close" size={16} color={palette.textSoft} />
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}

              <TextInput
                value={composerValue}
                onChangeText={setComposerValue}
                placeholder="Ask anything... @files, $skills, /commands"
                placeholderTextColor={palette.textSoft}
                multiline
                style={{
                  minHeight: 56,
                  maxHeight: 112,
                  color: palette.textStrong,
                  fontSize: 16,
                  lineHeight: 22,
                  textAlignVertical: "top",
                  paddingHorizontal: 2,
                  paddingTop: 2,
                  paddingBottom: 46,
                  backgroundColor: palette.keyboardBar,
                }}
              />

              <View
                style={{
                  position: "absolute",
                  left: 12,
                  right: 12,
                  bottom: 8,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                  <Pressable
                    onPress={() => setSheet("attach")}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      borderCurve: "continuous",
                      backgroundColor: palette.surface,
                      borderWidth: 1,
                      borderColor: palette.cardBorder,
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                    <Glyph name="plus" size={20} color={palette.textStrong} />
                  </Pressable>
                  <SelectorPill
                    label="Model"
                    value={formatModelLabel(model)}
                    palette={palette}
                    onPress={() => setSheet("model")}
                    compact
                    showLabel={false}
                  />
                  <SelectorPill
                    label="Effort"
                    value={effortChoices.find((candidate) => candidate.id === effort)?.label ?? effort}
                    palette={palette}
                    onPress={() => setSheet("effort")}
                    compact
                    showLabel={false}
                  />
                </View>
                <Pressable
                  onPress={() => void handleSend()}
                  style={{
                    height: 34,
                    borderRadius: 17,
                    borderCurve: "continuous",
                    backgroundColor: sending ? palette.textSoft : palette.textStrong,
                    alignItems: "center",
                    justifyContent: "center",
                    paddingHorizontal: 10,
                    flexDirection: "row",
                    gap: 4,
                    flexShrink: 0,
                  }}>
                  <Text style={{ color: palette.mode === "dark" ? "#111111" : "#ffffff", fontSize: 12, fontWeight: "900" }}>
                    {sending ? "..." : "Send"}
                  </Text>
                  <Glyph name="arrow-up-right" size={13} color={palette.mode === "dark" ? "#111111" : "#ffffff"} />
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </DrawerLayoutAndroid>

      <SelectionSheet open={sheet === "provider"} title="Provider" palette={palette} onClose={() => setSheet(null)}>
        {availableProviders.map((option) => (
          <ChoiceRow
            key={option.id}
            title={option.label}
            subtitle={`${option.models.length} models available`}
            selected={provider === option.id}
            palette={palette}
            onPress={() => {
              setProvider(option.id);
              setModel(option.defaultModel || option.models[0]?.id || "");
              setSheet(null);
            }}
          />
        ))}
      </SelectionSheet>

      <SelectionSheet open={sheet === "model"} title="Model" palette={palette} onClose={() => setSheet(null)}>
        {selectedProviderConfig.models.map((candidate) => (
          <ChoiceRow
            key={candidate.id}
            title={candidate.label || formatModelLabel(candidate.id)}
            subtitle={`${provider} model`}
            selected={model === candidate.id}
            palette={palette}
            onPress={() => {
              setModel(candidate.id);
              setSheet(null);
            }}
          />
        ))}
      </SelectionSheet>

      <SelectionSheet open={sheet === "effort"} title="Reasoning" palette={palette} onClose={() => setSheet(null)}>
        {effortChoices.map((candidate) => (
          <ChoiceRow
            key={candidate.id}
            title={candidate.label}
            subtitle={candidate.subtitle}
            selected={effort === candidate.id}
            palette={palette}
            onPress={() => {
              setEffort(candidate.id);
              setSheet(null);
            }}
          />
        ))}
      </SelectionSheet>

      <SelectionSheet open={sheet === "theme"} title="Theme" palette={palette} onClose={() => setSheet(null)}>
        {THEME_OPTIONS.map((candidate) => (
          <ChoiceRow
            key={candidate.id}
            title={candidate.label}
            subtitle={candidate.subtitle}
            selected={themeMode === candidate.id}
            palette={palette}
            onPress={() => {
              setThemeMode(candidate.id);
              setSheet(null);
            }}
          />
        ))}
      </SelectionSheet>

      <SelectionSheet open={sheet === "attach"} title="Add Attachment" palette={palette} onClose={() => setSheet(null)}>
        <ChoiceRow
          title="Photo Library"
          subtitle="Choose one or more images"
          selected={false}
          palette={palette}
          onPress={() => {
            void handlePickImage("library");
          }}
        />
        <ChoiceRow
          title="Camera"
          subtitle="Take a picture now"
          selected={false}
          palette={palette}
          onPress={() => {
            void handlePickImage("camera");
          }}
        />
        <ChoiceRow
          title="Files"
          subtitle="Pick documents from the phone"
          selected={false}
          palette={palette}
          onPress={() => {
            void handlePickDocument();
          }}
        />
      </SelectionSheet>
    </>
  );
}
