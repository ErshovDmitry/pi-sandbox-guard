// tests/guard.test.ts — hook-level tests for the extension factory with a
// stubbed ExtensionAPI (plan atom 2, "scopeIsolation"). No real git: the
// stub scripts porcelain stdout per status call.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import createExtension from "../src/index.ts";
import { ENV_KEY } from "../src/config.ts";
import { STATUS_ARGS } from "../src/snapshot.ts";

const GIT_TIMEOUT_MS = 10_000; // locked in src/index.ts

interface FakeExecResult { stdout: string; stderr: string; code: number; killed: boolean; truncated: boolean }
interface ExecRecord { args: string[]; options?: ExecOptions }
type Handler = (event: Record<string, unknown>, ctx: { cwd: string; signal: AbortSignal }) => Promise<unknown> | unknown;

interface StubPi {
  on(event: string, handler: Handler): () => void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<FakeExecResult>;
  getSettings(): Record<string, unknown>;
}

// Typed boundary: one `as unknown as` cast (never `as never`) so host
// API drift still surfaces here while the stub stays minimal.
function stubApi(pi: StubPi): ExtensionAPI {
  return pi as unknown as ExtensionAPI;
}

interface StubOptions {
  /** undefined means "not a git repo" (rev-parse exits non-zero). */
  repoRoot?: string;
  /** Porcelain stdout per successive status call; exec throws after N calls (0 = never). */
  statusCalls: string[];
  settings?: Record<string, unknown>;
  failExecAfterCalls?: number;
}

function makeStub(options: StubOptions) {
  const handlers = new Map<string, Handler[]>();
  const execLog: ExecRecord[] = [];
  let statusIndex = 0;
  let execCalls = 0;

  const pi: StubPi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      // Unsubscribe removes ONLY this handler (splice, not delete-all).
      return () => {
        const current = handlers.get(event);
        if (!current) return;
        const i = current.indexOf(handler);
        if (i >= 0) current.splice(i, 1);
      };
    },
    async exec(command, args, execOptions) {
      execCalls += 1;
      if (options.failExecAfterCalls && execCalls > options.failExecAfterCalls) {
        throw new Error("spawn git ENOENT");
      }
      execLog.push({ args: [command, ...args], options: execOptions });
      if (args[0] === "rev-parse") {
        if (options.repoRoot === undefined) {
          return { stdout: "", stderr: "fatal: not a git repository", code: 128, killed: false, truncated: false };
        }
        return { stdout: options.repoRoot + "\n", stderr: "", code: 0, killed: false, truncated: false };
      }
      const stdout = options.statusCalls[statusIndex++] ?? "";
      return { stdout, stderr: "", code: 0, killed: false, truncated: false };
    },
    getSettings() {
      return options.settings ?? {};
    },
  };

  const controller = new AbortController();
  const ctx = { cwd: "/work/repo", signal: controller.signal };

  async function emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
    let result: unknown = undefined;
    for (const handler of handlers.get(event) ?? []) {
      const r = await handler(payload, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }

  return { pi, emit, execLog, ctx };
}

function toolCall(id: string) {
  return { toolName: "subagent", toolCallId: id, input: {} };
}

function toolResult(id: string, extra: Record<string, unknown> = {}) {
  return { toolName: "subagent", toolCallId: id, input: {}, content: [{ type: "text", text: "worker done" }], isError: false, ...extra };
}

test("tool_call snapshots git status in ctx.cwd (locked args)", async () => {
  const { pi, emit, execLog, ctx } = makeStub({ repoRoot: "/work/repo", statusCalls: [""] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const statusCall = execLog.find((r) => r.args[0] === "git" && r.args[1] === "status");
  assert.ok(statusCall);
  assert.deepEqual(statusCall!.args.slice(1), [...STATUS_ARGS]);
  // ExecOptions threading: actual ctx.cwd, locked timeout, ctx.signal.
  assert.equal(statusCall!.options?.cwd, ctx.cwd);
  assert.equal(statusCall!.options?.timeout, GIT_TIMEOUT_MS);
  assert.equal(statusCall!.options?.signal, ctx.signal);
  const revCall = execLog.find((r) => r.args[1] === "rev-parse");
  assert.ok(revCall);
  assert.equal(revCall!.options?.cwd, ctx.cwd);
});

test("unsubscribe removes only its own handler", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: [""] });
  let seen = 0;
  const offA = pi.on("tool_result", () => { seen += 1; });
  pi.on("tool_result", () => { seen += 10; });
  offA();
  await emit("tool_result", toolResult("call-1"));
  assert.equal(seen, 10);
});

test("non-git cwd: silent skip, no snapshot, no warning", async () => {
  const { pi, emit } = makeStub({ repoRoot: undefined, statusCalls: [""] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const patch = await emit("tool_result", toolResult("call-1"));
  assert.equal(patch, undefined);
});

test("tool_result appends a warning listing changed files", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", "?? rules/new.yml\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const patch: any = await emit("tool_result", toolResult("call-1"));
  assert.ok(patch);
  const last = patch.content[patch.content.length - 1];
  assert.equal(last.type, "text");
  assert.ok(last.text.includes("sandbox-guard"));
  assert.ok(last.text.includes("rules/new.yml"));
  assert.ok(last.text.includes("/work/repo"));
  // Original content preserved before the warning.
  assert.equal(patch.content[0].text, "worker done");
});

test("tool_result preserves structuredContent", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", "?? new.txt\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const patch: any = await emit("tool_result", toolResult("call-1", { structuredContent: { ok: true } }));
  assert.ok(patch);
  assert.deepEqual(patch.structuredContent, { ok: true });
});

test("no changes: tool_result returns undefined", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", ""] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const patch = await emit("tool_result", toolResult("call-1"));
  assert.equal(patch, undefined);
});

test("other tools are ignored", async () => {
  const { pi, emit, execLog } = makeStub({ repoRoot: "/work/repo", statusCalls: ["?? x\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", { toolName: "bash", toolCallId: "b-1", input: {} });
  assert.equal(execLog.length, 0);
  const patch = await emit("tool_result", { ...toolResult("b-1"), toolName: "bash" });
  assert.equal(patch, undefined);
});

test("tool_execution_end cleans the snapshot idempotently", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", "?? new.txt\0", "?? new.txt\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  await emit("tool_execution_end", { toolCallId: "call-1", toolName: "subagent" });
  await emit("tool_execution_end", { toolCallId: "call-1", toolName: "subagent" });
  const patch = await emit("tool_result", toolResult("call-1"));
  assert.equal(patch, undefined);
});

test("parallel toolCallIds are isolated via distinct baselines", async () => {
  // Distinct per-id baselines: a shared-snapshot implementation would
  // diff across baselines and leak files into the wrong warning.
  const { pi, emit } = makeStub({
    repoRoot: "/work/repo",
    statusCalls: ["?? base-a.txt\0", "?? base-b.txt\0", "?? base-a.txt\0?? a.txt\0", "?? base-b.txt\0?? b.txt\0"],
  });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-a"));
  await emit("tool_call", toolCall("call-b"));
  const patchA: any = await emit("tool_result", toolResult("call-a"));
  const patchB: any = await emit("tool_result", toolResult("call-b"));
  assert.ok(patchA.content.at(-1).text.includes("a.txt"));
  assert.ok(!patchA.content.at(-1).text.includes("b.txt"));
  assert.ok(!patchA.content.at(-1).text.includes("base-b.txt"));
  assert.ok(patchB.content.at(-1).text.includes("b.txt"));
  assert.ok(!patchB.content.at(-1).text.includes("a.txt"));
  assert.ok(!patchB.content.at(-1).text.includes("base-a.txt"));
});

test("nested subagent calls: outer and inner each get their own snapshot", async () => {
  // outer "" ; inner "" ; inner result inner.txt ; outer result outer.txt.
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", "", "?? inner.txt\0", "?? outer.txt\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("outer"));
  await emit("tool_call", { ...toolCall("outer/1"), parentToolCallId: "outer" });
  const innerPatch: any = await emit("tool_result", { ...toolResult("outer/1"), parentToolCallId: "outer" });
  const outerPatch: any = await emit("tool_result", toolResult("outer"));
  assert.ok(innerPatch.content.at(-1).text.includes("inner.txt"));
  assert.ok(!innerPatch.content.at(-1).text.includes("outer.txt"));
  assert.ok(outerPatch.content.at(-1).text.includes("outer.txt"));
  assert.ok(!outerPatch.content.at(-1).text.includes("inner.txt"));
});

test("repeat tool_result for the same id is tolerated defensively (no dedup)", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", "?? one.txt\0", "?? one.txt\0?? two.txt\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const first: any = await emit("tool_result", toolResult("call-1"));
  const second: any = await emit("tool_result", toolResult("call-1"));
  assert.ok(first.content.at(-1).text.includes("one.txt"));
  assert.ok(second.content.at(-1).text.includes("two.txt"));
});

test("env PI_SANDBOX_GUARD=off disables the guard", async (t) => {
  process.env[ENV_KEY] = "off";
  t.after(() => { delete process.env[ENV_KEY]; });
  const { pi, emit, execLog } = makeStub({ repoRoot: "/work/repo", statusCalls: ["", "?? new.txt\0"] });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  assert.equal(execLog.length, 0);
  const patch = await emit("tool_result", toolResult("call-1"));
  assert.equal(patch, undefined);
});

test("settings sandboxGuard.ignorePaths suppress matching warnings", async () => {
  const { pi, emit } = makeStub({
    repoRoot: "/work/repo",
    statusCalls: ["", "?? build/out.js\0?? src/real.ts\0"],
    settings: { sandboxGuard: { ignorePaths: ["build/**"] } },
  });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const patch: any = await emit("tool_result", toolResult("call-1"));
  assert.ok(patch.content.at(-1).text.includes("src/real.ts"));
  assert.ok(!patch.content.at(-1).text.includes("build/out.js"));
});

test("settings sandboxGuard.enabled=false disables the guard", async () => {
  const { pi, emit, execLog } = makeStub({
    repoRoot: "/work/repo",
    statusCalls: ["", "?? new.txt\0"],
    settings: { sandboxGuard: { enabled: false } },
  });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  assert.equal(execLog.length, 0);
  const patch = await emit("tool_result", toolResult("call-1"));
  assert.equal(patch, undefined);
});

test("a failing exec at tool_call never breaks the hooks", async () => {
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: [""] });
  const failing: StubPi = {
    ...pi,
    async exec(): Promise<FakeExecResult> { throw new Error("spawn git ENOENT"); },
  };
  createExtension(stubApi(failing));
  const callPatch = await emit("tool_call", toolCall("call-1"));
  assert.equal(callPatch, undefined);
  const resultPatch = await emit("tool_result", toolResult("call-1"));
  assert.equal(resultPatch, undefined);
});

test("a failing exec at tool_result is warn-only (returns undefined)", async () => {
  // rev-parse + status succeed at tool_call; tool_result exec then throws.
  const { pi, emit } = makeStub({ repoRoot: "/work/repo", statusCalls: [""], failExecAfterCalls: 2 });
  createExtension(stubApi(pi));
  await emit("tool_call", toolCall("call-1"));
  const patch = await emit("tool_result", toolResult("call-1"));
  assert.equal(patch, undefined);
});
