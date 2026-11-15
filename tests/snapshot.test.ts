// tests/snapshot.test.ts — unit tests for the pure porcelain/diff/filter/
// format functions (plan atom 2). No git, no pi, no network.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  STATUS_ARGS,
  diffStatus,
  filterEntries,
  formatWarning,
  matchesAnyGlob,
  matchesGlobPattern,
  parsePorcelain,
} from "../src/snapshot.ts";

// ─── STATUS_ARGS (LOCKED command) ──────────────────────────────────────

test("STATUS_ARGS is the locked porcelain v1 -z command", () => {
  assert.deepEqual([...STATUS_ARGS], [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
});

// ─── parsePorcelain ────────────────────────────────────────────────────

test("parsePorcelain: empty input yields an empty map", () => {
  assert.equal(parsePorcelain("").size, 0);
});

test("parsePorcelain: NUL-separated records with XY codes", () => {
  const out = " M src/a.ts\0?? new.txt\0D  gone.txt\0";
  const map = parsePorcelain(out);
  assert.equal(map.size, 3);
  assert.equal(map.get("src/a.ts"), " M");
  assert.equal(map.get("new.txt"), "??");
  assert.equal(map.get("gone.txt"), "D ");
});

test("parsePorcelain: paths with spaces and non-ASCII are verbatim", () => {
  const out = "?? dir with spaces/my file.txt\0 M ファイル/日本語.md\0";
  const map = parsePorcelain(out);
  assert.equal(map.get("dir with spaces/my file.txt"), "??");
  assert.equal(map.get("ファイル/日本語.md"), " M");
});

test("parsePorcelain: quotes and backslashes are not parsed", () => {
  // With -z git never quotes; a literal quote or backslash in the name is
  // just a character. The JS literals below escape them for the parser.
  const out = "?? we\"ird\\name.txt\0";
  const map = parsePorcelain(out);
  assert.equal(map.get("we\"ird\\name.txt"), "??");
});

test("parsePorcelain: synthetic dir/ record is stored verbatim, not collapsed", () => {
  const out = "?? dir/inner.txt\0";
  const map = parsePorcelain(out);
  assert.equal(map.get("dir/inner.txt"), "??");
  assert.equal(map.has("dir/"), false);
});

test("parsePorcelain: synthetic delete+add pair parses as two records, no arrow", () => {
  const out = " D old-name.ts\0?? new-name.ts\0";
  const map = parsePorcelain(out);
  assert.equal(map.get("old-name.ts"), " D");
  assert.equal(map.get("new-name.ts"), "??");
  for (const path of map.keys()) assert.ok(!path.includes("->"));
});

test("parsePorcelain: malformed segments are skipped", () => {
  const out = "?? \0XY\0?? ok.txt\0";
  const map = parsePorcelain(out);
  assert.deepEqual([...map.keys()], ["ok.txt"]);
});

test("parsePorcelain: R/C record skips its NUL-appended source path", () => {
  // Synthetic defensive fixture: --no-renames is LOCKED, but if an R/C XY
  // ever slips through, -z appends the source path as the next record.
  const out = "R  renamed.ts\0old name.ts\0C  copied.ts\0src/copy src.ts\0?? ok.txt\0";
  const map = parsePorcelain(out);
  assert.equal(map.get("renamed.ts"), "R ");
  assert.equal(map.get("copied.ts"), "C ");
  assert.equal(map.get("ok.txt"), "??");
  assert.equal(map.has("old name.ts"), false);
  assert.equal(map.has("src/copy src.ts"), false);
});

// ─── diffStatus ────────────────────────────────────────────────────────

test("diffStatus: identical maps yield no changes", () => {
  const m = parsePorcelain(" M a.ts\0");
  assert.deepEqual(diffStatus(m, new Map(m)), []);
});

test("diffStatus: new path detected", () => {
  const before = parsePorcelain(" M a.ts\0");
  const after = parsePorcelain(" M a.ts\0?? b.ts\0");
  assert.deepEqual(diffStatus(before, after), [{ path: "b.ts", xy: "??" }]);
});

test("diffStatus: XY change detected for the same path", () => {
  const before = parsePorcelain(" M a.ts\0");
  const after = parsePorcelain("D  a.ts\0");
  assert.deepEqual(diffStatus(before, after), [{ path: "a.ts", xy: "D " }]);
});

test("diffStatus: deleted path is not a change", () => {
  const before = parsePorcelain(" M a.ts\0?? scratch.txt\0");
  const after = parsePorcelain(" M a.ts\0");
  assert.deepEqual(diffStatus(before, after), []);
});

test("diffStatus: multiple new paths are sorted", () => {
  const before = parsePorcelain("");
  const after = parsePorcelain("?? z.txt\0?? a.txt\0?? m.txt\0");
  const paths = diffStatus(before, after).map((e) => e.path);
  assert.deepEqual(paths, ["a.txt", "m.txt", "z.txt"]);
});

// ─── glob matching ─────────────────────────────────────────────────────

test("matchesGlobPattern: exact match", () => {
  assert.ok(matchesGlobPattern("src/index.ts", "src/index.ts"));
  assert.ok(!matchesGlobPattern("src/other.ts", "src/index.ts"));
});

test("matchesGlobPattern: star does not cross directories", () => {
  assert.ok(matchesGlobPattern("a.log", "*.log"));
  assert.ok(!matchesGlobPattern("dir/a.log", "*.log"));
});

test("matchesGlobPattern: double star crosses directories", () => {
  assert.ok(matchesGlobPattern("tmp/x/y.txt", "tmp/**"));
  assert.ok(!matchesGlobPattern("other/x.txt", "tmp/**"));
});

test("matchesGlobPattern: **/ matches zero leading directories (root file)", () => {
  assert.ok(matchesGlobPattern("x.ts", "**/x.ts"));
  assert.ok(matchesGlobPattern("a/x.ts", "**/x.ts"));
  assert.ok(matchesGlobPattern("a/b/x.ts", "**/x.ts"));
  assert.ok(!matchesGlobPattern("a/x.js", "**/x.ts"));
  assert.ok(!matchesGlobPattern("xa.ts", "**/x.ts"));
});

test("matchesGlobPattern: src/**/t.ts matches zero, one and two directories", () => {
  assert.ok(matchesGlobPattern("src/t.ts", "src/**/t.ts"));
  assert.ok(matchesGlobPattern("src/a/t.ts", "src/**/t.ts"));
  assert.ok(matchesGlobPattern("src/a/b/t.ts", "src/**/t.ts"));
  assert.ok(!matchesGlobPattern("other/t.ts", "src/**/t.ts"));
  assert.ok(!matchesGlobPattern("src/a/x.ts", "src/**/t.ts"));
});

test("matchesGlobPattern: question mark matches one character", () => {
  assert.ok(matchesGlobPattern("dir/a.txt", "dir/?.txt"));
  assert.ok(!matchesGlobPattern("dir/ab.txt", "dir/?.txt"));
});

test("matchesGlobPattern: regex metacharacters are literal", () => {
  assert.ok(matchesGlobPattern("a.b[c]", "a.b[c]"));
  assert.ok(!matchesGlobPattern("axb[c]", "a.b[c]"));
});

test("matchesGlobPattern: backslash is a literal, not a regex escape", () => {
  // A RegExp-based matcher would compile "a\\nb" to "a<newline>b" and
  // match neither the literal backslash form.
  assert.ok(matchesGlobPattern("a\\nb.txt", "a\\nb.txt"));
  assert.ok(!matchesGlobPattern("a\nb.txt", "a\\nb.txt"));
  assert.ok(matchesGlobPattern("dir\\sub\\f.ts", "dir\\sub\\f.ts"));
});

test("matchesGlobPattern: hostile long pattern and path stay correct", () => {
  // ReDoS bait for a naive matcher: "*a*a…b" vs a long "aaa…" path is
  // exponential without memoization. Only the deterministic result is
  // asserted — no wall-clock timing, so the test cannot flake under load.
  const glob = "*a".repeat(100) + "b";
  const path = "a".repeat(500);
  assert.ok(matchesGlobPattern(path + "b", glob));
  assert.ok(!matchesGlobPattern(path + "c", glob));
  assert.ok(matchesGlobPattern(path + "/z", "*".repeat(200)));
});

test("matchesAnyGlob: empty list matches nothing", () => {
  assert.equal(matchesAnyGlob("a.txt", []), false);
});

// ─── filterEntries ─────────────────────────────────────────────────────

test("filterEntries: empty config passes everything through", () => {
  const entries = diffStatus(parsePorcelain(""), parsePorcelain("?? a.txt\0 M b.ts\0"));
  const kept = filterEntries(entries, { ignorePaths: [], ignoreStatus: [] });
  assert.equal(kept.length, 2);
});

test("filterEntries: ignoreStatus drops exact XY codes", () => {
  const entries = diffStatus(parsePorcelain(""), parsePorcelain("?? a.txt\0 M b.ts\0"));
  const kept = filterEntries(entries, { ignorePaths: [], ignoreStatus: ["??"] });
  assert.deepEqual(kept.map((e) => e.path), ["b.ts"]);
});

test("filterEntries: ignorePaths drops matching globs", () => {
  const entries = diffStatus(
    parsePorcelain(""),
    parsePorcelain("?? build/out.js\0?? src/main.ts\0"),
  );
  const kept = filterEntries(entries, { ignorePaths: ["build/**"], ignoreStatus: [] });
  assert.deepEqual(kept.map((e) => e.path), ["src/main.ts"]);
});

test("filterEntries: ignorePaths and ignoreStatus combine as a union drop", () => {
  const entries = diffStatus(
    parsePorcelain(""),
    parsePorcelain("?? build/out.js\0?? src/main.ts\0 M src/keep.ts\0?? notes.txt\0"),
  );
  const kept = filterEntries(entries, {
    ignorePaths: ["build/**"],
    ignoreStatus: ["??"],
  });
  assert.deepEqual(kept.map((e) => e.path), ["src/keep.ts"]);
});

// ─── formatWarning ─────────────────────────────────────────────────────

test("formatWarning: no entries yields an empty string", () => {
  assert.equal(formatWarning([], "/repo", 10), "");
});

test("formatWarning: lists paths with the total count", () => {
  const entries = [
    { path: "a.txt", xy: "??" },
    { path: "b dir/c.ts", xy: " M" },
    { path: "d.md", xy: "M " },
  ];
  const text = formatWarning(entries, "/repo", 10);
  assert.ok(text.includes("/repo"));
  assert.ok(text.includes('"a.txt", "b dir/c.ts", "d.md"'));
  assert.ok(text.includes("(3)"));
});

test("formatWarning: caps listed paths and reports the overflow", () => {
  const entries = [
    { path: "a.txt", xy: "??" },
    { path: "b.txt", xy: "??" },
    { path: "c.txt", xy: "??" },
  ];
  const text = formatWarning(entries, "/repo", 2);
  assert.ok(text.includes('"a.txt", "b.txt"'));
  assert.ok(!text.includes("c.txt"));
  assert.ok(text.includes("… +1 more"));
  assert.ok(text.includes("(3)"));
});

test("formatWarning: a comma path is JSON-quoted so the output is unambiguous", () => {
  const text = formatWarning([{ path: "we,ird.txt", xy: "??" }], "/repo", 10);
  assert.equal(text, '⚠️ sandbox-guard: subagent modified files in /repo: "we,ird.txt" (1)');
});

test("formatWarning: newline and control characters are JSON-escaped", () => {
  const text = formatWarning([{ path: "a\nb\t\"c\".txt", xy: "??" }], "/repo", 10);
  assert.equal(
    text,
    '⚠️ sandbox-guard: subagent modified files in /repo: "a\\nb\\t\\"c\\".txt" (1)',
  );
  assert.ok(!text.slice(text.indexOf(": ") + 2).includes("\n"));
});

test("formatWarning: maxPaths 0 lists no bare paths and reports all as overflow", () => {
  const entries = [
    { path: "a.txt", xy: "??" },
    { path: "b.txt", xy: "??" },
  ];
  const text = formatWarning(entries, "/repo", 0);
  assert.ok(!text.includes("a.txt"));
  assert.ok(text.includes("… +2 more"));
  assert.ok(text.includes("(2)"));
});

test("formatWarning: non-finite maxPaths clamps to zero", () => {
  const entries = [{ path: "a.txt", xy: "??" }];
  const text = formatWarning(entries, "/repo", NaN);
  assert.ok(!text.includes("a.txt"));
  assert.ok(text.includes("… +1 more"));
  assert.ok(text.includes("(1)"));
});

test("formatWarning: fractional maxPaths floors to the integer part", () => {
  const entries = [
    { path: "a.txt", xy: "??" },
    { path: "b.txt", xy: "??" },
    { path: "c.txt", xy: "??" },
  ];
  const text = formatWarning(entries, "/repo", 1.9);
  assert.ok(text.includes('"a.txt"'));
  assert.ok(!text.includes("b.txt"));
  assert.ok(text.includes("… +2 more"));
  assert.ok(text.includes("(3)"));
});
