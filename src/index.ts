// src/index.ts — pi-sandbox-guard extension factory.
//
// Watches exactly one repository: ctx.cwd of the pi session that spawned the
// subagent (plan atom 1, "Scope"). On every subagent tool call it snapshots
// git status in that repo; when the call finishes it appends a warning to
// the tool result if new or modified files appeared. Warn-only: never
// blocks, reverts or deletes anything.
//
// Hook choice (plan atom 1): the warning is injected in "tool_result" —
// the only hook that may modify a result. "tool_execution_end" is
// observational (its return value is ignored), so it only cleans up
// snapshots, idempotently.

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  ENV_KEY,
  resolveConfig,
  type SandboxGuardConfig,
  type SandboxGuardRaw,
} from "./config.ts";
import {
  STATUS_ARGS,
  diffStatus,
  filterEntries,
  formatWarning,
  parsePorcelain,
  type StatusMap,
} from "./snapshot.ts";

const SUBAGENT_TOOL = "subagent";
const GIT_TIMEOUT_MS = 10_000;

interface RepoStatus {
  root: string;
  map: StatusMap;
}

/**
 * Run the LOCKED status command in cwd. Returns undefined for a silent
 * skip: not a git repo (rev-parse failed or printed nothing) or a status
 * failure (repo vanished mid-call). Never throws.
 */
async function readRepoStatus(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RepoStatus | undefined> {
  const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    signal,
  });
  if (top.code !== 0) return undefined;
  const root = top.stdout.trim();
  if (!root) return undefined;
  const status = await pi.exec("git", [...STATUS_ARGS], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    signal,
  });
  if (status.code !== 0) return undefined;
  return { root, map: parsePorcelain(status.stdout) };
}

function readSandboxGuardSetting(pi: ExtensionAPI): SandboxGuardRaw {
  const settings: Record<string, unknown> = pi.getSettings() as Record<string, unknown>;
  return settings["sandboxGuard"] as SandboxGuardRaw;
}

function logConfigWarning(warning: string | undefined): void {
  if (warning) process.stderr.write("pi-sandbox-guard: " + warning + "\n");
}


export default function (pi: ExtensionAPI): void {
  /**
   * Snapshots keyed by toolCallId: nested and parallel calls are isolated.
   * The resolved config is cached with the map so tool_result never
   * re-resolves it (and never repeats the config warning).
   */
  const snapshots = new Map<
    string,
    { map: StatusMap; config: SandboxGuardConfig }
  >();

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    try {
      if (event.toolName !== SUBAGENT_TOOL) return undefined;
      const { config, warning } = resolveConfig(
        readSandboxGuardSetting(pi),
        process.env[ENV_KEY],
      );
      logConfigWarning(warning);
      if (!config.enabled) return undefined;
      const status = await readRepoStatus(pi, ctx.cwd, ctx.signal);
      if (!status) return undefined;
      snapshots.set(event.toolCallId, { map: status.map, config });
    } catch {
      // Warn-only: a tool_call error would block the call (host fail-safe),
      // so failures here are swallowed on purpose.
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    try {
      if (event.toolName !== SUBAGENT_TOOL) return undefined;
      const snapshot = snapshots.get(event.toolCallId);
      if (!snapshot) return undefined;
      const status = await readRepoStatus(pi, ctx.cwd, ctx.signal);
      if (!status) return undefined;
      const changed = filterEntries(
        diffStatus(snapshot.map, status.map),
        snapshot.config,
      );
      if (changed.length === 0) return undefined;
      const text = formatWarning(changed, status.root, snapshot.config.maxPaths);
      // Keep structuredContent: returning content alone drops it (host docs).
      const patch: ToolResultEventResult = {
        content: [...event.content, { type: "text", text }],
      };
      if (event.structuredContent !== undefined) {
        patch.structuredContent = event.structuredContent;
      }
      return patch;
    } catch {
      // Warn-only: never break the tool result.
      return undefined;
    }
  });

  pi.on("tool_execution_end", (event) => {
    try {
      // Idempotent cleanup; also covers calls that never reached tool_result
      // (blocked, aborted, errored).
      snapshots.delete(event.toolCallId);
    } catch {
      /* cleanup must never throw */
    }
    return undefined;
  });

  pi.on("session_shutdown", () => {
    try {
      snapshots.clear();
    } catch {
      /* cleanup must never throw */
    }
    return undefined;
  });
}

