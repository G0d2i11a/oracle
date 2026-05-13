import path from "node:path";

export type BrowserOwnerLabelSource =
  | "explicit"
  | "env"
  | "slug"
  | "cwd-pid"
  | "cwd"
  | "pid"
  | "session-id";

export interface BrowserOwnerLabelResolution {
  label: string;
  source: BrowserOwnerLabelSource;
}

export interface BrowserOwnerLabelInput {
  explicit?: string | null;
  optionSlug?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  pid?: number | null;
  env?: NodeJS.ProcessEnv;
}

const MAX_OWNER_LABEL_LENGTH = 80;
const OWNER_ENV_KEYS = [
  "ORACLE_BROWSER_OWNER_LABEL",
  "ORACLE_BROWSER_OWNER",
  "ORACLE_OWNER_LABEL",
  "ORACLE_AGENT_LABEL",
  "ORACLE_AGENT_OWNER",
  "RALPH_AGENT_LABEL",
  "RALPH_AGENT_ID",
  "CODEX_AGENT_LABEL",
];

export function sanitizeBrowserOwnerLabel(value: unknown): string | undefined {
  const normalized = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  const sanitized = normalized
    .replace(/[^a-zA-Z0-9._:@/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_OWNER_LABEL_LENGTH)
    .replace(/^-|-$/g, "");
  return sanitized || undefined;
}

function normalizePid(value: unknown): number | null {
  const pid = Number(value);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  return Math.trunc(pid);
}

function readOwnerLabelFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of OWNER_ENV_KEYS) {
    const label = sanitizeBrowserOwnerLabel(env[key]);
    if (label) {
      return label;
    }
  }
  return undefined;
}

export function deriveBrowserOwnerLabel(
  input: BrowserOwnerLabelInput = {},
): BrowserOwnerLabelResolution | null {
  const explicit = sanitizeBrowserOwnerLabel(input.explicit);
  if (explicit) {
    return { label: explicit, source: "explicit" };
  }

  const envLabel = readOwnerLabelFromEnv(input.env ?? process.env);
  if (envLabel) {
    return { label: envLabel, source: "env" };
  }

  const optionSlug = sanitizeBrowserOwnerLabel(input.optionSlug);
  if (optionSlug) {
    return { label: optionSlug, source: "slug" };
  }

  const cwdBase = sanitizeBrowserOwnerLabel(input.cwd ? path.basename(input.cwd) : undefined);
  const pid = normalizePid(input.pid);
  if (cwdBase && pid) {
    return { label: `${cwdBase}:pid-${pid}`, source: "cwd-pid" };
  }
  if (cwdBase) {
    return { label: cwdBase, source: "cwd" };
  }
  if (pid) {
    return { label: `pid-${pid}`, source: "pid" };
  }

  const sessionId = sanitizeBrowserOwnerLabel(input.sessionId);
  if (sessionId) {
    return { label: sessionId, source: "session-id" };
  }

  return null;
}
