// src/snapshot.ts — pure functions for the sandbox guard: porcelain v1 -z
// parsing, snapshot diffing, ignore filtering and warning formatting.
// No pi, no git, no I/O in this module: everything here is unit-testable
// in isolation (plan atom 2). The git invocation itself lives in index.ts.

export interface StatusEntry {
  path: string;
  xy: string;
}

/** path -> XY status code, as parsed from git status --porcelain=v1 -z. */
export type StatusMap = Map<string, string>;

/**
 * LOCKED status command arguments (plan atom 2, do not change):
 * -z keeps pathnames verbatim (no quoting/escaping), NUL-terminated;
 * --untracked-files=all expands untracked dirs into individual files;
 * --no-renames reports renames as a delete + an add, so no "->" parsing.
 */
export const STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--no-renames",
] as const;

/**
 * Parse git status --porcelain=v1 -z stdout into a StatusMap.
 *
 * With -z, records are separated by NUL (0x00) bytes and each non-empty
 * record is exactly "XY PATH": a two-character status code, one space, then
 * the raw path. Quoting, backslash-escapes and rename arrows never appear,
 * so paths with spaces or non-ASCII characters are taken verbatim.
 */
export function parsePorcelain(stdout: string): StatusMap {
  const map: StatusMap = new Map();
  if (!stdout) return map;
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) continue;
    // Need at least "XY p": two status chars, the separator space, one path char.
    if (record.length < 4) continue;
    if (record[2] !== " ") continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0) continue;
    map.set(path, xy);
    // Defensive: --no-renames is LOCKED, but if a rename/copy XY ever slips
    // through, -z appends the source path as the next NUL record; skip it so
    // a source path like "x  y" is not misparsed as an "XY " record.
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return map;
}

function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Entries that appeared or changed their XY code between the snapshot taken
 * at tool_call and the status taken at tool_result. Paths that disappeared
 * (e.g. a scratch file created and deleted within the call) are not changes.
 */
export function diffStatus(before: StatusMap, after: StatusMap): StatusEntry[] {
  const changed: StatusEntry[] = [];
  for (const [path, xy] of after) {
    if (!before.has(path) || before.get(path) !== xy) {
      changed.push({ path, xy });
    }
  }
  changed.sort((a, b) => comparePaths(a.path, b.path));
  return changed;
}

/**
 * Linear-memory, polynomial-time glob matcher (no RegExp, so hostile
 * patterns cannot cause ReDoS). "*" matches any run of characters except
 * "/", "**" matches across directories, and a "**" directly followed by
 * a slash matches zero or more leading directories (so that two-token
 * pattern also matches a root-level file), while "?" matches one non-"/"
 * character. All other characters, including backslash and every regex
 * metacharacter, are literal. The whole path must match. Results are
 * memoized on (pathIndex, globIndex) so the recursion is at most
 * path.length * glob.length states — no exponential blow-up.
 */
export function matchesGlobPattern(path: string, glob: string): boolean {
  const memo = new Map<string, boolean>();
  const matchFrom = (pi: number, gi: number): boolean => {
    const key = pi + "," + gi;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (gi >= glob.length) {
      result = pi >= path.length;
    } else if (glob.charAt(gi) === "*") {
      if (glob.charAt(gi + 1) === "*") {
        if (glob.charAt(gi + 2) === "/") {
          // "**/": zero leading directories, or consume one directory and retry.
          const nextSlash = path.indexOf("/", pi);
          result =
            matchFrom(pi, gi + 3) ||
            (nextSlash !== -1 && matchFrom(nextSlash + 1, gi));
        } else {
          // "**": any run of characters, including slashes.
          result = false;
          for (let i = pi; i <= path.length && !result; i++) {
            result = matchFrom(i, gi + 2);
          }
        }
      } else {
        // "*": any run of characters except "/".
        const stop = path.indexOf("/", pi);
        const end = stop === -1 ? path.length : stop;
        result = false;
        for (let i = pi; i <= end && !result; i++) {
          result = matchFrom(i, gi + 1);
        }
      }
    } else if (glob.charAt(gi) === "?") {
      result = pi < path.length && path.charAt(pi) !== "/" && matchFrom(pi + 1, gi + 1);
    } else {
      result = pi < path.length && path.charAt(pi) === glob.charAt(gi) && matchFrom(pi + 1, gi + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matchFrom(0, 0);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  return globs.some((glob) => matchesGlobPattern(path, glob));
}

/** Drop entries ignored via ignoreStatus (exact XY match) or ignorePaths (glob). */
export function filterEntries(
  entries: readonly StatusEntry[],
  ignore: { ignorePaths: readonly string[]; ignoreStatus: readonly string[] },
): StatusEntry[] {
  if (ignore.ignoreStatus.length === 0 && ignore.ignorePaths.length === 0) {
    return [...entries];
  }
  return entries.filter(
    (e) =>
      !ignore.ignoreStatus.includes(e.xy) &&
      !ignore.ignorePaths.some((glob) => matchesGlobPattern(e.path, glob)),
  );
}

/**
 * Render the warning appended to the subagent tool result, or "" when there
 * is nothing to report. maxPaths caps the listed paths; the overflow is
 * summarised as "… +M more". The total count is always shown at the end.
 * Each path is JSON.stringify'd so newline/control characters are escaped
 * and embedded commas stay unambiguous; a non-finite, zero, negative or
 * fractional maxPaths is clamped (fractions floored) and lists no bare path
 * when the effective limit is zero.
 */
export function formatWarning(
  entries: readonly StatusEntry[],
  repoRoot: string,
  maxPaths: number,
): string {
  if (entries.length === 0) return "";
  const limit = Number.isFinite(maxPaths) ? Math.max(0, Math.floor(maxPaths)) : 0;
  const shown = entries.slice(0, limit);
  const list = shown.map((e) => JSON.stringify(e.path)).join(", ");
  const overflow = entries.length - shown.length;
  const parts: string[] = [];
  if (list) parts.push(list);
  if (overflow > 0) parts.push("… +" + overflow + " more");
  return (
    "⚠️ sandbox-guard: subagent modified files in " +
    repoRoot +
    ": " +
    parts.join(" ") +
    " (" +
    entries.length +
    ")"
  );
}
