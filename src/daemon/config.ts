/**
 * User settings — `~/.grokrc/config.json`.
 *
 * Exists because flags alone don't survive the way grokrc actually runs. Under
 * systemd there is no shell, no `cd`, and no meaningful `process.cwd()` — so a
 * daemon started at boot put every phone-created session in the user's HOME
 * rather than a project, and the agent had no repo in context.
 *
 * Precedence, highest first:
 *   1. CLI flag           explicit, this invocation only
 *   2. config.json        the durable answer
 *   3. built-in default   last resort
 *
 * `defaultCwd` deliberately has NO usable built-in default. Guessing a working
 * directory for someone else's machine is worse than saying "set this" — so it
 * is unset on a fresh install and the daemon says so at startup.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CONFIG_DIR } from './auth.ts';
import { ensureConfigDir } from './config-dir.ts';

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface GrokrcConfig {
  /** Working directory for sessions created without one. No safe default. */
  defaultCwd?: string;
  port?: number;
  host?: string;
  /** Bind 0.0.0.0 rather than loopback. */
  lan?: boolean;
  /** How many past sessions to list. */
  historyLimit?: number;
  /** Model override for new sessions. */
  model?: string;
  /** Share one backend with a running `grok agent leader`. */
  leader?: boolean;
}

const KNOWN_KEYS: (keyof GrokrcConfig)[] = [
  'defaultCwd',
  'port',
  'host',
  'lan',
  'historyLimit',
  'model',
  'leader',
];

export async function loadConfig(): Promise<GrokrcConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: GrokrcConfig = {};
    // Copy only keys we understand — a typo in the file should not silently
    // become a setting nobody reads.
    for (const k of KNOWN_KEYS) {
      if (parsed[k] !== undefined) (out as Record<string, unknown>)[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: GrokrcConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export function configPath(): string {
  return CONFIG_PATH;
}

export interface ConfigIssue {
  key: string;
  message: string;
  fatal: boolean;
}

/**
 * Validate what we can cheaply. A `defaultCwd` that doesn't exist is reported
 * rather than corrected: silently falling back would reintroduce exactly the
 * "sessions land in $HOME" surprise this file was added to remove.
 */
export function validateConfig(cfg: GrokrcConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (cfg.defaultCwd !== undefined) {
    // `isAbsolute`, not `startsWith('/')`: the latter is absolute only on POSIX,
    // so on Windows `grokrc config set defaultCwd C:\code` was refused as "must
    // be an absolute path" — the one required setting could not be set at all.
    // See the same fix in session-manager.ts assertSafeCwd.
    if (typeof cfg.defaultCwd !== 'string' || !isAbsolute(cfg.defaultCwd)) {
      issues.push({
        key: 'defaultCwd',
        message: 'must be an absolute path',
        fatal: true,
      });
    } else {
      try {
        if (!statSync(cfg.defaultCwd).isDirectory()) {
          issues.push({ key: 'defaultCwd', message: 'is not a directory', fatal: true });
        }
      } catch {
        issues.push({ key: 'defaultCwd', message: 'does not exist', fatal: true });
      }
    }
  }

  if (cfg.port !== undefined && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)) {
    issues.push({ key: 'port', message: 'must be an integer 1–65535', fatal: true });
  }
  if (
    cfg.historyLimit !== undefined &&
    (!Number.isInteger(cfg.historyLimit) || cfg.historyLimit < 0)
  ) {
    issues.push({ key: 'historyLimit', message: 'must be a non-negative integer', fatal: true });
  }

  return issues;
}

/** Coerce a CLI string into the type a key expects. */
export function coerceValue(key: string, raw: string): unknown {
  if (key === 'port' || key === 'historyLimit') return Number(raw);
  if (key === 'lan' || key === 'leader') return raw === 'true' || raw === '1';
  return raw;
}

export function isKnownKey(key: string): key is keyof GrokrcConfig {
  return (KNOWN_KEYS as string[]).includes(key);
}

export const CONFIG_KEYS = KNOWN_KEYS;

/**
 * Shown when no defaultCwd is configured. Not a warning about a broken install —
 * it is the one thing a new user genuinely must decide, and the daemon cannot
 * guess it.
 */
export function missingCwdNotice(): string {
  return [
    '',
    '  ⚠ No default project directory configured.',
    '',
    "    Sessions started from your phone will open in this process's working",
    '    directory — under systemd that is not a project, so the agent starts',
    '    with no repo in context.',
    '',
    '    Set it once:',
    '',
    '        grokrc config set defaultCwd /path/to/your/projects',
    '',
  ].join('\n');
}

/**
 * What a reload is allowed to touch. Structural on purpose: a test supplies
 * recorders instead of a live daemon, so the LOGIC under test is this function
 * — production code — rather than a second copy of it written in the test file.
 *
 * That copy is what existed before. `test/config-reload.test.ts` defined its own
 * `reload` handler and asserted against that, so both of the controls here could
 * be deleted outright and the test stayed green. It was measuring itself.
 */
export interface ReloadTargets {
  server: { applyConfig(next: { defaultCwd?: string; historyLimit?: number }): void };
  sessions: { applyConfig(next: { model?: string; useLeader?: boolean }): void };
}

/**
 * Re-read settings and apply what a running daemon can actually pick up.
 *
 * Honest by construction: it reports which keys took effect and which still need
 * a restart. `host`, `port` and `lan` are bound at listen() and cannot move on a
 * live socket; reporting them as applied would be a lie that only surfaces
 * later, when the daemon is still answering on the old port.
 */
export function applyReload(
  next: GrokrcConfig,
  boot: GrokrcConfig,
  bootDefaultCwd: string,
  targets: ReloadTargets
): { applied: string[]; needsRestart: string[] } {
  const applied: string[] = [];
  const needsRestart: string[] = [];

  if (next.defaultCwd && next.defaultCwd !== bootDefaultCwd) {
    targets.server.applyConfig({ defaultCwd: next.defaultCwd });
    applied.push('defaultCwd');
  }
  // Only report a key that actually CHANGED. Pushing historyLimit on every
  // reload — which the first version did — makes `config set defaultCwd` claim
  // it also applied a setting the user never touched.
  if (typeof next.historyLimit === 'number' && next.historyLimit !== boot.historyLimit) {
    targets.server.applyConfig({ historyLimit: next.historyLimit });
    applied.push('historyLimit');
  }
  targets.sessions.applyConfig({ model: next.model, useLeader: next.leader === true });
  if (next.model !== boot.model) applied.push('model');
  if ((next.leader === true) !== (boot.leader === true)) applied.push('leader');

  for (const k of ['host', 'port', 'lan'] as const) {
    if (JSON.stringify(next[k]) !== JSON.stringify(boot[k])) needsRestart.push(k);
  }
  return { applied, needsRestart };
}
