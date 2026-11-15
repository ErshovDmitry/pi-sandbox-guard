# pi-sandbox-guard

A [Pi](https://github.com/badlogic/pi-mono) extension that warns when a
subagent changes files in the working git repository. Motivated by incident
T-0183: a worker created a file in a production repo despite the brief
forbidding it. The dispatcher sees the warning in the subagent tool result,
including the list of touched paths.

**Warn-only.** The extension never blocks, reverts or deletes anything, and
never touches `isError`.

## Installation

The extension loads from `~/.pi/agent/extensions/`. For local development,
symlink the checkout (source: [github.com/ErshovDmitry/pi-sandbox-guard](https://github.com/ErshovDmitry/pi-sandbox-guard)):

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-sandbox-guard
```

Then reload the extensions (or start a new pi process) — the extension is
loaded at startup, and `pi` maps its `@earendil-works/pi-coding-agent`
import to the host copy, so no `npm install` is needed to run it.

## How it works

For every `subagent` tool call the extension:

1. `tool_call` — runs the LOCKED status command
   `git status --porcelain=v1 -z --untracked-files=all --no-renames` in
   `ctx.cwd` of the spawning session and stores the parsed snapshot keyed by
   `toolCallId`. Nested (`parentToolCallId`) and parallel calls each get an
   isolated snapshot. A non-git directory (or any git failure) is a silent
   skip.
2. `tool_result` — runs the same command again, diffs against the snapshot
   (new paths and paths whose XY status changed; disappeared paths are not
   changes), applies the ignore configuration, and appends a warning to the
   result content:

   > ⚠️ sandbox-guard: subagent modified files in /path/to/repo: "new.txt", "src/changed.ts" (2)

   `structuredContent` is always returned along with `content`; the host
   drops structured content when a `tool_result` patch replaces `content`
   without it.
3. `tool_execution_end` — deletes the snapshot, idempotently. This hook is
   observational (its return value is ignored by the host), which is why the
   warning is injected in `tool_result` instead — see Deviation below.

Snapshots live only in memory and are dropped when the call finalizes or the
session shuts down. No state is written to disk.

## Scope

Exactly one repository is monitored: `ctx.cwd` of the pi session that
registered the extension — the session spawning the subagent. `git status`
runs in that directory, but the repo path reported in the warning is the
repository root from `git rev-parse --show-toplevel`, so a session started
in a subdirectory still reports the top-level tree. The
subagent's own working directory override (`event.input.cwd`) is out of
scope by design: changes made elsewhere are not snapshotted and not
reported. This boundary is a deliberate v1 trade-off, not a bug.

## Configuration

All behavior comes from configuration; nothing is hardcoded. Resolution
order: env -> settings.json (project merged over global by the host) ->
built-in defaults. A malformed value falls back to the default for that
field and is reported via `process.stderr.write` (the extension has no pi log API).

settings.json:

```json
{
  "sandboxGuard": {
    "enabled": true,
    "ignorePaths": ["build/**", "*.log"],
    "ignoreStatus": ["??"],
    "maxPaths": 10
  }
}
```

- `enabled` (default `true`) — master switch.
- `ignorePaths` (default `[]`) — path globs excluded from warnings:
  `*` matches within a directory, `**` crosses directories, `?` matches one
  character.
- `ignoreStatus` (default `[]`) — exact porcelain XY codes excluded from
  warnings, e.g. `"??"` silences untracked-file noise.
- `maxPaths` (default `10`) — how many paths are listed per warning; the
  overflow is summarised as `… +M more` with the total in parentheses.
  Must be an integer `>= 1`; anything else falls back to the default.

Environment override:

```bash
PI_SANDBOX_GUARD=off   # disable entirely
```

Any common boolean token (`on`/`off`/`1`/`0`/`true`/`false`/`yes`/`no`,
case-insensitive) works. An empty or whitespace-only value counts as
unset and is silently ignored; only a malformed non-empty value is
ignored and reported via `process.stderr.write`.

## Development

No runtime dependencies — the extension imports only Node builtins and the
host-provided `@earendil-works/pi-coding-agent` module, which pi maps to its
own copy at load time. The host package is a devDependency for typechecking
only; pi never installs devDependencies.

```bash
npm install
npm test            # node --import tsx --test tests/*.test.ts
npm run typecheck   # tsc --noEmit
```

Layout:

- `src/index.ts` — the extension factory: hook wiring, git invocation,
  per-`toolCallId` snapshot map.
- `src/snapshot.ts` — pure functions: porcelain `-z` parsing, snapshot diff,
  glob matching, ignore filtering, warning formatting.
- `src/config.ts` — pure functions: defaults, validation, env override.
- `tests/` — `node:test` suites for all of the above, including hook-level
  tests with a stubbed `ExtensionAPI` (parallel/nested isolation, structured
  content preservation, non-git silent skip).

## Deviation from the original task wording

The task mentioned producing the diff at `tool_execution_end`. Pi's
`tool_execution_end` hook is observational — its return value is ignored —
so the only legal place to modify the result is `tool_result`. The warning
is therefore injected there, and `tool_execution_end` performs cleanup
only. This matches the approved plan (atom 1).

## License

MIT, see [LICENSE](LICENSE).
