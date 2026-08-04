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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './auth.ts';

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
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
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
    if (typeof cfg.defaultCwd !== 'string' || !cfg.defaultCwd.startsWith('/')) {
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
