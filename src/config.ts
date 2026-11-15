// src/config.ts — sandbox guard configuration: defaults, validation and
// resolution order. No pi imports and no I/O: the settings value and the
// env value are passed in by the caller (index.ts), so this module stays
// unit-testable (plan atom 2).

export interface SandboxGuardConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Path globs ("**", "*", "?") excluded from warnings. Default none. */
  ignorePaths: string[];
  /** Exact XY status codes ("??", " M", ...) excluded from warnings. Default none. */
  ignoreStatus: string[];
  /** Maximum number of paths listed in one warning. Default 10. */
  maxPaths: number;
}

export const DEFAULT_MAX_PATHS = 10;

export const DEFAULT_CONFIG: SandboxGuardConfig = {
  enabled: true,
  ignorePaths: [],
  ignoreStatus: [],
  maxPaths: DEFAULT_MAX_PATHS,
};

/** Env override: "off" disables the guard entirely. */
export const ENV_KEY = "PI_SANDBOX_GUARD";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Raw value of the "sandboxGuard" settings key, before validation. */
export type SandboxGuardRaw = JsonValue | undefined;

export interface ResolvedConfig {
  config: SandboxGuardConfig;
  /** Human-readable problem found while validating; undefined when clean. */
  warning?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanToken(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

function parseMaxPaths(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/**
 * Validate one raw settings value (the merged "sandboxGuard" key from
 * settings.json — project already merged over global by the host) and apply
 * the env override. A malformed value never throws: the offending part falls
 * back to defaults and a warning describes what was ignored.
 *
 * Priority: env > settings (project > global already merged by the host) >
 * defaults.
 */
export function resolveConfig(raw: SandboxGuardRaw, envRaw: string | undefined): ResolvedConfig {
  // Clone array defaults so resolved configs never share mutable state
  // with DEFAULT_CONFIG or with each other.
  const config: SandboxGuardConfig = {
    ...DEFAULT_CONFIG,
    ignorePaths: [...DEFAULT_CONFIG.ignorePaths],
    ignoreStatus: [...DEFAULT_CONFIG.ignoreStatus],
  };
  const warnings: string[] = [];

  if (raw !== undefined) {
    if (!isPlainObject(raw)) {
      warnings.push('"sandboxGuard" must be an object; using defaults');
    } else {
      if (raw.enabled !== undefined) {
        if (typeof raw.enabled === "boolean") {
          config.enabled = raw.enabled;
        } else {
          warnings.push('"sandboxGuard.enabled" must be a boolean; using default');
        }
      }
      if (raw.ignorePaths !== undefined) {
        const paths = parseStringArray(raw.ignorePaths);
        if (paths !== undefined) {
          config.ignorePaths = paths;
        } else {
          warnings.push('"sandboxGuard.ignorePaths" must be an array of strings; using default');
        }
      }
      if (raw.ignoreStatus !== undefined) {
        const status = parseStringArray(raw.ignoreStatus);
        if (status !== undefined) {
          config.ignoreStatus = status;
        } else {
          warnings.push('"sandboxGuard.ignoreStatus" must be an array of strings; using default');
        }
      }
      if (raw.maxPaths !== undefined) {
        const maxPaths = parseMaxPaths(raw.maxPaths);
        if (maxPaths !== undefined) {
          config.maxPaths = maxPaths;
        } else {
          warnings.push('"sandboxGuard.maxPaths" must be an integer >= 1; using default');
        }
      }
    }
  }

  // An empty or whitespace-only value counts as unset.
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const parsed = parseBooleanToken(envRaw);
    if (parsed === undefined) {
      warnings.push(
        ENV_KEY +
          ' must be one of on/off, true/false, yes/no, 1/0; ignoring "' +
          envRaw +
          '"',
      );
    } else {
      config.enabled = parsed;
    }
  }

  return { config, warning: warnings.length > 0 ? warnings.join("; ") : undefined };
}
