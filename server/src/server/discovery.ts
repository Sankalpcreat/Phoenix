import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import type { AgentProvider } from "../shared/types"
import { resolveLocalPath } from "./paths"

export interface DiscoveredProject {
  localPath: string
  title: string
  modifiedAt: number
}

export interface ProviderDiscoveredProject extends DiscoveredProject {
  provider: AgentProvider
}

export interface DiscoveredCodexChat {
  provider: "codex"
  sessionId: string
  localPath: string
  title: string
  modifiedAt: number
  rolloutPath: string
}

export interface ProjectDiscoveryAdapter {
  provider: AgentProvider
  scan(homeDir?: string): ProviderDiscoveredProject[]
}

function resolveEncodedClaudePath(folderName: string) {
  const segments = folderName.replace(/^-/, "").split("-").filter(Boolean)
  let currentPath = ""
  let remainingSegments = [...segments]

  while (remainingSegments.length > 0) {
    let found = false

    for (let index = remainingSegments.length; index >= 1; index -= 1) {
      const segment = remainingSegments.slice(0, index).join("-")
      const candidate = `${currentPath}/${segment}`

      if (existsSync(candidate)) {
        currentPath = candidate
        remainingSegments = remainingSegments.slice(index)
        found = true
        break
      }
    }

    if (!found) {
      const [head, ...tail] = remainingSegments
      currentPath = `${currentPath}/${head}`
      remainingSegments = tail
    }
  }

  return currentPath || "/"
}

function normalizeExistingDirectory(localPath: string) {
  try {
    const normalized = resolveLocalPath(localPath)
    if (!statSync(normalized).isDirectory()) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

function mergeDiscoveredProjects(projects: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const merged = new Map<string, DiscoveredProject>()

  for (const project of projects) {
    const existing = merged.get(project.localPath)
    if (!existing || project.modifiedAt > existing.modifiedAt) {
      merged.set(project.localPath, {
        localPath: project.localPath,
        title: project.title || path.basename(project.localPath) || project.localPath,
        modifiedAt: project.modifiedAt,
      })
      continue
    }

    if (!existing.title && project.title) {
      existing.title = project.title
    }
  }

  return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export class ClaudeProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "claude" as const

  scan(homeDir: string = homedir()): ProviderDiscoveredProject[] {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    if (!existsSync(projectsDir)) {
      return []
    }

    const entries = readdirSync(projectsDir, { withFileTypes: true })
    const projects: ProviderDiscoveredProject[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const resolvedPath = resolveEncodedClaudePath(entry.name)
      const normalizedPath = normalizeExistingDirectory(resolvedPath)
      if (!normalizedPath) {
        continue
      }

      const stat = statSync(path.join(projectsDir, entry.name))
      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: stat.mtimeMs,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

interface CodexSessionIndexEntry {
  updatedAt: number
  threadName: string | null
}

function readCodexSessionIndex(indexPath: string) {
  const sessionsById = new Map<string, CodexSessionIndexEntry>()
  if (!existsSync(indexPath)) {
    return sessionsById
  }

  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    const id = typeof record.id === "string" ? record.id : null
    const updatedAt = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN
    const threadName = typeof record.thread_name === "string" ? record.thread_name.trim() : null
    if (!id || Number.isNaN(updatedAt)) continue

    const existing = sessionsById.get(id)
    if (!existing || updatedAt > existing.updatedAt) {
      sessionsById.set(id, {
        updatedAt,
        threadName: threadName || null,
      })
    }
  }

  return sessionsById
}

function collectCodexSessionFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return []
  }

  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectCodexSessionFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath)
    }
  }
  return files
}

function readCodexConfiguredProjects(configPath: string) {
  const projects = new Map<string, number>()
  if (!existsSync(configPath)) {
    return projects
  }

  const configMtime = statSync(configPath).mtimeMs
  for (const line of readFileSync(configPath, "utf8").split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configMtime)
  }

  return projects
}

function readCodexSessionMetadata(sessionsDir: string) {
  const metadataById = new Map<string, { cwd: string; modifiedAt: number; rolloutPath: string }>()

  for (const sessionFile of collectCodexSessionFiles(sessionsDir)) {
    const fileStat = statSync(sessionFile)
    const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0]
    if (!firstLine?.trim()) continue

    const record = parseJsonRecord(firstLine)
    if (!record || record.type !== "session_meta") continue

    const payload = record.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue

    const payloadRecord = payload as Record<string, unknown>
    const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
    const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
    if (!sessionId || !cwd) continue

    const recordTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    const payloadTimestamp = typeof payloadRecord.timestamp === "string" ? Date.parse(payloadRecord.timestamp) : Number.NaN
    const modifiedAt = [recordTimestamp, payloadTimestamp, fileStat.mtimeMs].find((value) => !Number.isNaN(value)) ?? fileStat.mtimeMs

    metadataById.set(sessionId, { cwd, modifiedAt, rolloutPath: sessionFile })
  }

  return metadataById
}

function parseTimestamp(timestamp: unknown, fallback: number) {
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN
  return Number.isNaN(parsed) ? fallback : parsed
}

function transcriptId(sessionId: string, lineIndex: number, kind: "user" | "assistant") {
  return `codex-import:${sessionId}:${lineIndex}:${kind}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function parseCodexRolloutTranscript(sessionId: string, rolloutPath: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const lines = readFileSync(rolloutPath, "utf8").split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    if (record.type === "event_msg") {
      const payload = asRecord(record.payload)
      if (!payload) continue
      const createdAt = parseTimestamp(record.timestamp, Date.now())

      if (payload.type === "user_message" && typeof payload.message === "string" && payload.message.trim()) {
        entries.push({
          _id: transcriptId(sessionId, index, "user"),
          createdAt,
          kind: "user_prompt",
          content: payload.message,
        })
        continue
      }

      if (payload.type === "agent_message" && typeof payload.message === "string" && payload.message.trim()) {
        entries.push({
          _id: transcriptId(sessionId, index, "assistant"),
          createdAt,
          kind: "assistant_text",
          text: payload.message,
        })
      }
    }
  }

  return entries
}

export class CodexProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "codex" as const

  scan(homeDir: string = homedir()): ProviderDiscoveredProject[] {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const sessionsById = readCodexSessionIndex(indexPath)
    const metadataById = readCodexSessionMetadata(sessionsDir)
    const configuredProjects = readCodexConfiguredProjects(configPath)
    const projects: ProviderDiscoveredProject[] = []

    for (const [sessionId, metadata] of metadataById.entries()) {
      const modifiedAt = sessionsById.get(sessionId)?.updatedAt ?? metadata.modifiedAt
      const cwd = metadata.cwd
      if (!cwd) {
        continue
      }
      if (!path.isAbsolute(cwd)) {
        continue
      }

      const normalizedPath = normalizeExistingDirectory(cwd)
      if (!normalizedPath) {
        continue
      }

      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      })
    }

    for (const [configuredPath, modifiedAt] of configuredProjects.entries()) {
      if (!path.isAbsolute(configuredPath)) {
        continue
      }

      const normalizedPath = normalizeExistingDirectory(configuredPath)
      if (!normalizedPath) {
        continue
      }

      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

export function discoverCodexChats(homeDir: string = homedir()): DiscoveredCodexChat[] {
  const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
  const sessionsDir = path.join(homeDir, ".codex", "sessions")
  const sessionsById = readCodexSessionIndex(indexPath)
  const metadataById = readCodexSessionMetadata(sessionsDir)
  const chats: DiscoveredCodexChat[] = []

  for (const [sessionId, metadata] of metadataById.entries()) {
    const cwd = metadata.cwd
    if (!cwd || !path.isAbsolute(cwd)) {
      continue
    }

    const normalizedPath = normalizeExistingDirectory(cwd)
    if (!normalizedPath) {
      continue
    }

    const sessionIndex = sessionsById.get(sessionId)
    const modifiedAt = sessionIndex?.updatedAt ?? metadata.modifiedAt
    chats.push({
      provider: "codex",
      sessionId,
      localPath: normalizedPath,
      title: sessionIndex?.threadName || path.basename(normalizedPath) || sessionId,
      modifiedAt,
      rolloutPath: metadata.rolloutPath,
    })
  }

  return chats.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export const DEFAULT_PROJECT_DISCOVERY_ADAPTERS: ProjectDiscoveryAdapter[] = [
  new ClaudeProjectDiscoveryAdapter(),
  new CodexProjectDiscoveryAdapter(),
]

export function discoverProjects(
  homeDir: string = homedir(),
  adapters: ProjectDiscoveryAdapter[] = DEFAULT_PROJECT_DISCOVERY_ADAPTERS
): DiscoveredProject[] {
  const mergedProjects = mergeDiscoveredProjects(
    adapters.flatMap((adapter) => adapter.scan(homeDir).map(({ provider: _provider, ...project }) => project))
  )

  return mergedProjects
}
