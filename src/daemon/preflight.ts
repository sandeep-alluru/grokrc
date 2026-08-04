/**
 * Startup preflight.
 *
 * The single most important finding from end-to-end testing: **Grok Build does
 * not ask for permission by default.** `[features] support_permission` defaults
 * to false, and a user config may additionally set `[ui] permission_mode` to
 * `auto` / `dontAsk` / `bypassPermissions`.
 *
 * With either in force, `session/request_permission` is never sent — so grokrc's
 * core feature silently does nothing, and worse, an agent driven from a phone
 * executes every tool unattended. That is the opposite of what someone enabling
 * remote control expects.
 *
 * We refuse to fail silently: the daemon inspects the effective config at
 * startup and says plainly what is wrong and how to fix it.
 *
 * Deliberately a narrow regex read rather than a TOML parse — we need two keys,
 * and a dependency to read two keys is not worth it. Ambiguity resolves toward
 * warning, never toward false reassurance.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PermissionPosture {
  /** Will the agent actually ask before running tools? */
  willPrompt: boolean;
  supportPermission: boolean | null;
  permissionMode: string | null;
  configPath: string;
  reasons: string[];
}

const NON_PROMPTING_MODES = new Set(['auto', 'dontask', 'bypasspermissions', 'acceptedits']);

function readKey(toml: string, section: string, key: string): string | null {
  // Match `key = value` only within the given [section].
  const sectionRe = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const body = sectionRe.exec(toml)?.[1];
  if (!body) return null;
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*"?([A-Za-z0-9_-]+)"?`, 'm');
  return keyRe.exec(body)?.[1] ?? null;
}

export async function checkPermissionPosture(grokHome?: string): Promise<PermissionPosture> {
  const home = grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok');
  const configPath = join(home, 'config.toml');
  const reasons: string[] = [];

  let toml = '';
  try {
    toml = await readFile(configPath, 'utf8');
  } catch {
    // No config at all means defaults, and the default is not to prompt.
  }

  const rawSupport = readKey(toml, 'features', 'support_permission');
  const supportPermission = rawSupport === null ? null : rawSupport === 'true';
  const permissionMode = readKey(toml, 'ui', 'permission_mode');

  // Default is false — absence is not safety.
  if (supportPermission !== true) {
    reasons.push(
      supportPermission === null
        ? '[features] support_permission is unset (defaults to false — the agent never asks)'
        : '[features] support_permission = false'
    );
  }
  if (permissionMode && NON_PROMPTING_MODES.has(permissionMode.toLowerCase())) {
    reasons.push(`[ui] permission_mode = "${permissionMode}"`);
  }

  return {
    willPrompt: reasons.length === 0,
    supportPermission,
    permissionMode,
    configPath,
    reasons,
  };
}

/** Human-facing warning. Returns null when the posture is fine. */
export function posturteWarning(p: PermissionPosture): string | null {
  if (p.willPrompt) return null;
  return [
    '',
    '  ⚠ THE AGENT WILL NOT ASK BEFORE RUNNING TOOLS.',
    '',
    ...p.reasons.map((r) => `      · ${r}`),
    '',
    `    Remote approval cannot work in this state — tools execute unattended,`,
    `    including writes and shell commands, with nothing to approve.`,
    '',
    `    Fix in ${p.configPath}:`,
    '',
    '        [features]',
    '        support_permission = true',
    '',
    '        [ui]',
    '        permission_mode = "default"',
    '',
  ].join('\n');
}
