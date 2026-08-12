/**
 * Live smoke for B15: cmd /c start Grok <handback.cmd>
 * Marker file proves the .cmd body ran (not a blank window).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  relaunchGrokTui,
  resolveGrokBinary,
  windowsCmdStartScriptArgs,
  writeWindowsRelaunchScript,
} = await import('../dist/daemon/relaunch-tui.js');

const marker = `smoke-alive-${Date.now()}`;
const markerFile = join(tmpdir(), `grokrc-${marker}.flag`);
try {
  unlinkSync(markerFile);
} catch {
  /* */
}

const bin = resolveGrokBinary();
console.log('grok bin:', bin, 'exists:', existsSync(bin));

// Controlled .cmd — first line writes marker, then stays open briefly.
const liveCmd = join(tmpdir(), `grokrc-handback-${marker}.cmd`);
writeFileSync(
  liveCmd,
  [
    '@echo off',
    'title Grok hand-back',
    'color 0A',
    'echo ========================================',
    'echo   Resuming Grok session (smoke)',
    'echo ========================================',
    `echo alive>"${markerFile}"`,
    'timeout /t 6 /nobreak >nul',
    '',
  ].join('\r\n'),
  'utf8'
);

const args = windowsCmdStartScriptArgs(liveCmd);
console.log('argv:', ['cmd.exe', ...args].join(' | '));
if (args[2] !== '"Grok"' || args[3] !== liveCmd || args.length !== 4) {
  console.error('FAIL bad argv (need quoted title token)', args);
  process.exit(1);
}

const helper = spawn('cmd.exe', args, {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  cwd: process.cwd(),
});
helper.unref();
console.log('helper pid', helper.pid);

let flagOk = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if (existsSync(markerFile)) {
    flagOk = true;
    break;
  }
}
if (!flagOk) {
  console.error('FAIL: handback .cmd never wrote marker (blank/failed window)');
  // Still report production API shape for debugging
  const r0 = relaunchGrokTui(process.cwd(), marker);
  console.error('relaunch would be:', r0);
  process.exit(1);
}
console.log('OK: marker written — .cmd body ran (not blank)');

const r = relaunchGrokTui(process.cwd(), marker);
console.log('relaunch:', JSON.stringify(r, null, 2));
if (!r.ok || !r.methods?.includes('cmd-start-script')) {
  console.error('FAIL expected cmd-start-script', r);
  process.exit(1);
}
const launches = r.methods.filter((m) =>
  ['cmd-start-script', 'start-process-grok', 'cmd-start', 'cmd-start-ps1'].includes(m)
);
if (launches.length !== 1) {
  console.error('FAIL multi-launch', launches);
  process.exit(1);
}
const bat = (r.methods.find((m) => m.startsWith('cmd:')) || '').slice(4);
if (!bat || !existsSync(bat)) {
  console.error('FAIL missing bat');
  process.exit(1);
}
const body = readFileSync(bat, 'utf8');
if (!body.includes('Resuming Grok session') || !body.includes('call ')) {
  console.error('FAIL bat body incomplete');
  process.exit(1);
}
// Production script must not rely on nested PowerShell -Command
const shape = writeWindowsRelaunchScript(process.cwd(), 'shape-sid', bin);
const shapeBody = readFileSync(shape, 'utf8');
if (!shapeBody.includes('grok') || !shapeBody.includes('-r')) {
  console.error('FAIL prod bat missing grok -r');
  process.exit(1);
}

console.log('SMOKE PASS: cmd-start-script runs body; single method; banner bat ok');
process.exit(0);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
