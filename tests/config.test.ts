// tests/config.test.ts — unit tests for config defaults, validation and
// the env override (plan atom 2). No pi, no I/O.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_PATHS,
  ENV_KEY,
  resolveConfig,
} from "../src/config.ts";

test("resolveConfig: undefined settings yields defaults without warning", () => {
  const { config, warning } = resolveConfig(undefined, undefined);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(config.maxPaths, DEFAULT_MAX_PATHS);
  assert.equal(warning, undefined);
});

test("resolveConfig: full valid object is honored", () => {
  const { config, warning } = resolveConfig(
    {
      enabled: false,
      ignorePaths: ["build/**"],
      ignoreStatus: ["??"],
      maxPaths: 3,
    },
    undefined,
  );
  assert.equal(config.enabled, false);
  assert.deepEqual(config.ignorePaths, ["build/**"]);
  assert.deepEqual(config.ignoreStatus, ["??"]);
  assert.equal(config.maxPaths, 3);
  assert.equal(warning, undefined);
});

test("resolveConfig: non-object value falls back to defaults with warning", () => {
  const { config, warning } = resolveConfig(42, undefined);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.ok(warning && warning.includes("sandboxGuard"));
});

test("resolveConfig: malformed fields fall back individually", () => {
  const { config, warning } = resolveConfig(
    { enabled: "yes", ignorePaths: "build", ignoreStatus: [1], maxPaths: 0 },
    undefined,
  );
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.deepEqual(config.ignorePaths, []);
  assert.deepEqual(config.ignoreStatus, []);
  assert.equal(config.maxPaths, DEFAULT_MAX_PATHS);
  assert.ok(warning && warning.split(";").length >= 4);
});

test("resolveConfig: partial object keeps defaults for missing fields", () => {
  const { config, warning } = resolveConfig({ maxPaths: 5 }, undefined);
  assert.equal(config.maxPaths, 5);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.ignorePaths, []);
  assert.equal(warning, undefined);
});

test("resolveConfig: env off disables the guard", () => {
  const { config, warning } = resolveConfig({ enabled: true }, "off");
  assert.equal(config.enabled, false);
  assert.equal(warning, undefined);
});

test("resolveConfig: env on enables the guard even when settings disable it", () => {
  const { config } = resolveConfig({ enabled: false }, "on");
  assert.equal(config.enabled, true);
});

test("resolveConfig: env accepts common boolean tokens", () => {
  assert.equal(resolveConfig(undefined, "0").config.enabled, false);
  assert.equal(resolveConfig(undefined, "FALSE").config.enabled, false);
  assert.equal(resolveConfig(undefined, "1").config.enabled, true);
  assert.equal(resolveConfig(undefined, "true").config.enabled, true);
});

test("resolveConfig: malformed env value is ignored with a warning", () => {
  const { config, warning } = resolveConfig(undefined, "maybe");
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.ok(warning && warning.includes(ENV_KEY));
});

test("ENV_KEY is PI_SANDBOX_GUARD", () => {
  assert.equal(ENV_KEY, "PI_SANDBOX_GUARD");
});

test("resolveConfig: empty or whitespace env is unset without warning", () => {
  for (const env of ["", "   ", "\t\n "]) {
    const { config, warning } = resolveConfig(undefined, env);
    assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
    assert.equal(warning, undefined);
  }
});

test("resolveConfig: env accepts all documented boolean pairs", () => {
  const truthy = ["on", "true", "yes", "1", "ON", " TRUE "];
  const falsy = ["off", "false", "no", "0", "Off", " no "];
  for (const env of truthy) {
    const { config, warning } = resolveConfig(undefined, env);
    assert.equal(config.enabled, true, env);
    assert.equal(warning, undefined, env);
  }
  for (const env of falsy) {
    const { config, warning } = resolveConfig(undefined, env);
    assert.equal(config.enabled, false, env);
    assert.equal(warning, undefined, env);
  }
});

test("resolveConfig: malformed env warning names all accepted pairs", () => {
  const { warning } = resolveConfig(undefined, "banana");
  assert.ok(warning && warning.includes(ENV_KEY));
  for (const pair of ["on/off", "true/false", "yes/no", "1/0"]) {
    assert.ok(warning && warning.includes(pair), pair);
  }
});

test("resolveConfig: returned arrays are independent clones of DEFAULT_CONFIG", () => {
  const { config: a } = resolveConfig(undefined, undefined);
  a.ignorePaths.push("dist/**");
  a.ignoreStatus.push("??");
  assert.deepEqual(DEFAULT_CONFIG.ignorePaths, []);
  assert.deepEqual(DEFAULT_CONFIG.ignoreStatus, []);
  const { config: b } = resolveConfig(undefined, undefined);
  assert.deepEqual(b.ignorePaths, []);
  assert.deepEqual(b.ignoreStatus, []);
});

test("resolveConfig: per-call results do not share array state", () => {
  const raw = { ignorePaths: ["build/**"], ignoreStatus: [" M"] };
  const { config: a } = resolveConfig(raw, undefined);
  a.ignorePaths.push("injected");
  a.ignoreStatus.push("!!");
  const { config: b } = resolveConfig(raw, undefined);
  assert.deepEqual(b.ignorePaths, ["build/**"]);
  assert.deepEqual(b.ignoreStatus, [" M"]);
});
