/**
 * Open a new OS terminal running `grok -r` after hand-back.
 *
 * B15 root cause of "blank CMD every time":
 *   Launch went through `powershell -Command "Start-Process … '/k call "….cmd"'"`
 *   Inner double quotes broke -Command → empty CMD whose *title* is the .cmd path.
 *
 * Fix:
 *   1. Write a .cmd that prints a green banner then `call grok.exe -r …`
 *   2. Launch with pure argv only (no powershell -Command):
 *        cmd.exe /c start "Grok" <absolute-path-to.cmd>
 *      Title token MUST be the characters "Grok" including quotes — bare Grok
 *      is treated as a program name and the .cmd never runs (B15).
 *   3. Exactly one launch — never multi-method storm.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RelaunchResult {
  ok: boolean;
  detail: string;
  methods?: string[];
}

function quotePs(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function quoteCmd(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

function ignoreChild(child: ChildProcess): void {
  child.on('error', () => {});
  child.unref();
}

/** Prefer a real on-disk binary — Task Scheduler / new consoles often lack PATH. */
export function resolveGrokBinary(): string {
  const win = platform() === 'win32';
  const named = win ? 'grok.exe' : 'grok';
  const candidates = [process.env.GROK_BIN, join(homedir(), '.grok', 'bin', named), named].filter(
    (x): x is string => typeof x === 'string' && x.length > 0
  );
  for (const c of candidates) {
    if (c === named || existsSync(c)) return c;
  }
  return named;
}

/**
 * Open a new terminal with `grok -r`. Async so Linux can wait for a real spawn
 * (ENOENT / missing DISPLAY are async on Node — a sync "ok" lied).
 */
export async function relaunchGrokTui(cwd: string, sessionId: string): Promise<RelaunchResult> {
  const os = platform();
  try {
    if (os === 'win32') return relaunchWindows(cwd, sessionId);
    if (os === 'darwin') return relaunchMac(cwd, sessionId);
    return await relaunchLinux(cwd, sessionId);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Sanitized session id for temp file names. */
function safeSessionFileId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, '') || 'session';
}

/**
 * PowerShell launcher — only single quotes, safe to embed in -Command or -File.
 * Prints a banner immediately so a blank window is never "silent success".
 */
export function writeWindowsRelaunchPs1(cwd: string, sessionId: string, grokBin?: string): string {
  const bin = grokBin ?? resolveGrokBinary();
  const ps1 = join(tmpdir(), `grokrc-handback-${safeSessionFileId(sessionId)}.ps1`);
  const body = [
    `$ErrorActionPreference = 'Continue'`,
    `$Host.UI.RawUI.WindowTitle = 'Grok hand-back'`,
    `Write-Host ''`,
    `Write-Host '========================================' -ForegroundColor Green`,
    `Write-Host '  Resuming Grok session' -ForegroundColor Green`,
    `Write-Host '  ${sessionId.replace(/'/g, "''")}' -ForegroundColor Green`,
    `Write-Host '========================================' -ForegroundColor Green`,
    `Write-Host ''`,
    `Set-Location -LiteralPath ${quotePs(cwd)}`,
    `if (-not $?) {`,
    `  Write-Host 'Failed to open session directory:' -ForegroundColor Red`,
    `  Write-Host ${quotePs(cwd)}`,
    `  Read-Host 'Press Enter to close'`,
    `  exit 1`,
    `}`,
    `Write-Host ('Directory: ' + (Get-Location))`,
    `Write-Host 'Starting grok -r (large sessions can take 30-90s to paint the TUI)...'`,
    `Write-Host ''`,
    `& ${quotePs(bin)} -r ${quotePs(sessionId)}`,
    `$code = $LASTEXITCODE`,
    `Write-Host ''`,
    `if ($code -ne 0) {`,
    `  Write-Host ('Grok exited with code ' + $code) -ForegroundColor Red`,
    `  Write-Host 'Retry:'`,
    `  Write-Host ('  & ' + ${quotePs(bin)} + ' -r ' + ${quotePs(sessionId)})`,
    `  Read-Host 'Press Enter to close'`,
    `  exit $code`,
    `}`,
    '',
  ].join('\r\n');
  writeFileSync(ps1, body, 'utf8');
  return ps1;
}

/** Legacy .cmd (still used as emergency fallback). */
export function writeWindowsRelaunchScript(
  cwd: string,
  sessionId: string,
  grokBin?: string
): string {
  const bin = grokBin ?? resolveGrokBinary();
  const bat = join(tmpdir(), `grokrc-handback-${safeSessionFileId(sessionId)}.cmd`);
  const body = [
    '@echo off',
    'setlocal',
    'title Grok hand-back',
    'color 0A',
    'echo.',
    'echo ========================================',
    'echo   Resuming Grok session',
    `echo   ${sessionId}`,
    'echo ========================================',
    'echo.',
    `cd /d ${quoteCmd(cwd)}`,
    'if errorlevel 1 (',
    '  echo Failed to open session directory:',
    `  echo ${cwd.replace(/%/g, '%%')}`,
    '  pause',
    '  exit /b 1',
    ')',
    'echo Directory: %CD%',
    'echo Starting grok -r ...',
    `call ${quoteCmd(bin)} -r ${sessionId}`,
    'if errorlevel 1 (',
    '  echo Grok failed. pause',
    '  pause',
    ')',
    '',
  ].join('\r\n');
  writeFileSync(bat, body, 'utf8');
  return bat;
}

/**
 * PowerShell one-liner that starts a *visible* PowerShell running the .ps1.
 * Only single-quoted paths — never nest `"` inside an outer -Command string.
 * Kept for tests / manual fallback; primary path uses argv (see windowsCmdStartPs1Args).
 */
export function windowsStartPs1Command(ps1Path: string): string {
  // -NoExit keeps the window if the script errors before Read-Host.
  return (
    `Start-Process -FilePath 'powershell.exe' ` +
    `-ArgumentList @('-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File',${quotePs(ps1Path)}) ` +
    `-WindowStyle Normal`
  );
}

/**
 * Pure argv for: cmd /c start "Grok" <script.cmd>
 *
 * CRITICAL (measured): the title token must include the quote characters
 * (`'"Grok"'` as one argv element). Bare `Grok` is treated by `start` as the
 * *program name*, so the .cmd never runs → blank/wrong window (B15).
 * Title is also non-empty so a path is never mistaken for the title (B13).
 */
export function windowsCmdStartScriptArgs(scriptPath: string): string[] {
  return ['/c', 'start', '"Grok"', scriptPath];
}

/** @deprecated use windowsCmdStartScriptArgs */
export function windowsCmdStartPs1Args(ps1Path: string): string[] {
  return windowsCmdStartScriptArgs(ps1Path);
}

export function windowsStartProcessCommand(
  cwd: string,
  sessionId: string,
  grokBin?: string
): string {
  const bin = grokBin ?? resolveGrokBinary();
  return (
    `Start-Process -FilePath ${quotePs(bin)} ` +
    `-ArgumentList @('-r',${quotePs(sessionId)}) ` +
    `-WorkingDirectory ${quotePs(cwd)} ` +
    `-WindowStyle Normal`
  );
}

export function windowsStartArgs(
  cwd: string,
  sessionId: string,
  grokBin?: string,
  scriptPath?: string
): string[] {
  // Quotes must be part of the argv token — see windowsCmdStartScriptArgs.
  const title = '"Grok"';
  if (scriptPath) {
    return ['/c', 'start', title, scriptPath];
  }
  const bin = grokBin ?? resolveGrokBinary();
  const run = /[\s"]/.test(bin) ? `${quoteCmd(bin)} -r ${sessionId}` : `${bin} -r ${sessionId}`;
  return ['/c', 'start', title, '/D', cwd, 'cmd.exe', '/k', run];
}

export function windowsPowerShellResumeCommand(
  cwd: string,
  sessionId: string,
  grokBin?: string
): string {
  const bin = grokBin ?? resolveGrokBinary();
  const invoke = /[\s']/.test(bin) ? `& ${quotePs(bin)}` : bin;
  return `Set-Location -LiteralPath ${quotePs(cwd)}; ${invoke} -r ${sessionId}`;
}

function relaunchWindows(cwd: string, sessionId: string): RelaunchResult {
  const bin = resolveGrokBinary();
  const methods: string[] = [];

  // --- Primary: cmd /c start Grok <handback.cmd>  (pure argv — B13 + B15)
  try {
    const bat = writeWindowsRelaunchScript(cwd, sessionId, bin);
    methods.push(`cmd:${bat}`);
    const child = spawn('cmd.exe', windowsCmdStartScriptArgs(bat), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd,
    });
    ignoreChild(child);
    methods.push('cmd-start-script');
    return {
      ok: true,
      detail: `launched handback .cmd via cmd start (${bat})`,
      methods,
    };
  } catch (err) {
    methods.push(`cmd-start-script-failed:${(err as Error).message}`);
  }

  // --- Fallback: Start-Process grok.exe (single-quoted paths only, no nested ")
  try {
    const ps = windowsStartProcessCommand(cwd, sessionId, bin);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    ignoreChild(child);
    methods.push('start-process-grok');
    return { ok: true, detail: 'launched grok via Start-Process', methods };
  } catch (err) {
    methods.push(`start-process-grok-failed:${(err as Error).message}`);
  }

  return {
    ok: false,
    detail: `all methods failed: ${methods.join('; ')}`,
    methods,
  };
}

function relaunchMac(cwd: string, sessionId: string): RelaunchResult {
  const bin = resolveGrokBinary();
  const inner = `cd ${JSON.stringify(cwd)} && exec ${JSON.stringify(bin)} -r ${sessionId}`;
  const script = `tell application "Terminal" to do script ${JSON.stringify(inner)}`;
  const child = spawn('osascript', ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  ignoreChild(child);
  return { ok: true, detail: 'requested Terminal.app' };
}

/** True if `cmd` resolves on PATH (or is an absolute existing path). */
function commandOnPath(cmd: string): boolean {
  if (!cmd) return false;
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd);
  const pathEnv = process.env.PATH ?? '';
  const sep = platform() === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    if (existsSync(join(dir, cmd))) return true;
  }
  return false;
}

/**
 * Spawn detached and wait until Node confirms the process started — or fails.
 * Returning ok:true the moment spawn() returns is a lie: missing binaries and
 * bad DISPLAY surface on the async `error` event, which we used to ignore.
 */
function spawnDetached(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<{ ok: true } | { ok: false; err: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: true } | { ok: false; err: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        cwd: opts.cwd,
        env: opts.env ?? process.env,
      });
    } catch (err) {
      finish({ ok: false, err: (err as Error).message });
      return;
    }
    child.once('error', (err) => finish({ ok: false, err: err.message }));
    child.once('spawn', () => {
      ignoreChild(child);
      finish({ ok: true });
    });
    // Older Node without a reliable 'spawn' event: pid set ⇒ launched.
    setTimeout(() => {
      if (settled) return;
      if (child.pid != null) {
        ignoreChild(child);
        finish({ ok: true });
      } else {
        finish({ ok: false, err: `${cmd}: no pid after spawn` });
      }
    }, 250);
  });
}

async function relaunchLinux(cwd: string, sessionId: string): Promise<RelaunchResult> {
  // systemd user units often start without a graphical session; refuse clearly
  // instead of claiming success when no window can appear.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return {
      ok: false,
      detail:
        'no DISPLAY or WAYLAND_DISPLAY in the daemon environment — cannot open a graphical terminal; use the copy-paste command',
    };
  }

  const bin = resolveGrokBinary();
  const shellCmd = `cd ${JSON.stringify(cwd)} && exec ${JSON.stringify(bin)} -r ${sessionId}; exec bash`;
  const candidates: { cmd: string; args: string[] }[] = [];
  if (process.env.TERMINAL) {
    candidates.push({
      cmd: process.env.TERMINAL,
      args: ['-e', 'bash', '-lc', shellCmd],
    });
  }
  // Prefer a real emulator over the Debian alternatives wrapper: on Ubuntu
  // x-terminal-emulator → gnome-terminal.wrapper, which has failed silently
  // for some hand-backs. gnome-terminal's `--` form is the reliable one.
  candidates.push(
    { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', shellCmd] },
    { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', shellCmd] },
    { cmd: 'konsole', args: ['-e', 'bash', '-lc', shellCmd] },
    { cmd: 'xfce4-terminal', args: ['-e', `bash -lc ${JSON.stringify(shellCmd)}`] },
    { cmd: 'xterm', args: ['-e', 'bash', '-lc', shellCmd] }
  );

  const tried: string[] = [];
  for (const c of candidates) {
    if (!commandOnPath(c.cmd)) {
      tried.push(`${c.cmd}: not on PATH`);
      continue;
    }
    const result = await spawnDetached(c.cmd, c.args, { cwd, env: process.env });
    if (result.ok) {
      return {
        ok: true,
        detail: `opened ${c.cmd}`,
        methods: tried.concat([c.cmd]),
      };
    }
    tried.push(`${c.cmd}: ${result.err}`);
  }
  return {
    ok: false,
    detail: `could not open a terminal (${tried.join('; ') || 'none available'})`,
    methods: tried,
  };
}
