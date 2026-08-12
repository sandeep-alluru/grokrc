/**
 * B10: start must not run program "grokrc".
 * B12: no nested cd /d in /k.
 * B13: start title must be non-empty.
 * B15: PowerShell -Command must not nest double-quoted paths (blank CMD).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, unlinkSync } from 'node:fs';
import {
  relaunchGrokTui,
  windowsStartArgs,
  windowsPowerShellResumeCommand,
  windowsStartProcessCommand,
  windowsStartPs1Command,
  windowsCmdStartPs1Args,
  windowsCmdStartScriptArgs,
  writeWindowsRelaunchScript,
  writeWindowsRelaunchPs1,
} from '../src/daemon/relaunch-tui.ts';

test('relaunchGrokTui returns a result object and does not throw', async () => {
  const r = await relaunchGrokTui(process.cwd(), '019fabcd-0000-7000-8000-00000000rl');
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0);
});

test('B13: windows start with script uses NON-empty title so path is not the title', () => {
  const sid = '019fabcd-0000-7000-8000-00000000b13';
  const cwd = 'C:\\Users\\me\\My Project';
  const script = 'C:\\Users\\me\\AppData\\Local\\Temp\\grokrc-handback-test.cmd';
  const args = windowsStartArgs(cwd, sid, 'C:\\Users\\me\\.grok\\bin\\grok.exe', script);

  assert.equal(args[0], '/c');
  assert.equal(args[1], 'start');
  assert.ok(args[2] && args[2].length > 0, 'title must be non-empty (B13)');
  assert.notEqual(args[2], script, 'title must not be the script path');
  assert.equal(args[3], script);
});

test('B14: Windows relaunch uses a single primary path (no multi-spawn storm)', async () => {
  const r = await relaunchGrokTui(process.cwd(), '019fabcd-0000-7000-8000-00000000b14');
  assert.equal(typeof r.ok, 'boolean');
  if (process.platform === 'win32') {
    assert.ok(Array.isArray(r.methods) && r.methods.length >= 1, String(r.methods));
    // Exactly one launch method — never fire .cmd + powershell + start together.
    const launches = r.methods!.filter(
      (m) =>
        m === 'cmd-start-script' ||
        m === 'cmd-start-ps1' ||
        m === 'start-process-ps1' ||
        m === 'start-process-grok' ||
        m === 'cmd-start' ||
        m === 'spawn-ps1-file' ||
        m.startsWith('spawn-grok') ||
        m.startsWith('explorer')
    );
    assert.equal(
      launches.length,
      1,
      `expected exactly one launch method, got ${launches.join('|')} full=${r.methods!.join('|')}`
    );
    assert.ok(
      r.methods!.includes('cmd-start-script'),
      `primary should be cmd-start-script: ${r.methods!.join('|')}`
    );
    assert.ok(
      r.methods!.some((m) => m.startsWith('cmd:')),
      `must write a .cmd launcher: ${r.methods!.join('|')}`
    );
  }
});

test('B15: cmd start script args use quoted title token so .cmd actually runs', () => {
  const bat = 'C:\\Users\\me\\AppData\\Local\\Temp\\grokrc-handback-x.cmd';
  const args = windowsCmdStartScriptArgs(bat);
  assert.equal(args[0], '/c');
  assert.equal(args[1], 'start');
  // Bare "Grok" is a program name; start needs the quotes in the token.
  assert.equal(args[2], '"Grok"', 'title must be quoted token for cmd start');
  assert.notEqual(args[2], bat, 'title must not be the script path');
  assert.equal(args[3], bat);
  assert.equal(args.length, 4);
  assert.ok(!args.some((a) => a.includes('Start-Process') || a.includes('/k call')));
  assert.deepEqual(windowsCmdStartPs1Args(bat), args);
});

test('hand-back script prints banner before starting grok', () => {
  const bat = writeWindowsRelaunchScript(
    'C:\\Agent-Hub\\grok-remote-control',
    '019fabcd-0000-7000-8000-00000000ban',
    'C:\\Users\\me\\.grok\\bin\\grok.exe'
  );
  try {
    const text = readFileSync(bat, 'utf8');
    assert.match(text, /Resuming Grok session/);
    assert.match(text, /Starting grok/i);
    assert.match(text, /call /);
    assert.match(text, /title Grok hand-back/);
  } finally {
    try {
      unlinkSync(bat);
    } catch {
      /* */
    }
  }
});

test('B15: ps1 launcher and Start-Process command use only single-quoted paths', () => {
  const sid = '019fabcd-0000-7000-8000-00000000b15';
  const cwd = 'C:\\Agent-Hub\\grok-remote-control';
  const bin = 'C:\\Users\\me\\.grok\\bin\\grok.exe';
  const ps1 = writeWindowsRelaunchPs1(cwd, sid, bin);
  try {
    const text = readFileSync(ps1, 'utf8');
    assert.match(text, /Resuming Grok session/);
    assert.match(text, /Set-Location -LiteralPath '/);
    assert.match(text, /grok\.exe'/);
    // Must not use double-quoted Windows paths (those break nested -Command).
    assert.ok(!/Set-Location -LiteralPath "/.test(text), text);
    const start = windowsStartPs1Command(ps1);
    assert.match(start, /Start-Process/);
    assert.match(start, /-File/);
    assert.ok(!start.includes(`"${ps1}"`), `must not double-quote path: ${start}`);
    assert.ok(start.includes(`'${ps1}'`) || start.includes(ps1.replace(/'/g, "''")), start);
  } finally {
    try {
      unlinkSync(ps1);
    } catch {
      /* */
    }
  }
});

test('B12: fallback /D form has no nested cd /d in /k', () => {
  const sid = '019fabcd-0000-7000-8000-00000000b12';
  const cwd = 'C:\\Agent-Hub\\grok-remote-control';
  const bin = 'C:\\Users\\me\\.grok\\bin\\grok.exe';
  const args = windowsStartArgs(cwd, sid, bin);

  assert.equal(args[1], 'start');
  assert.ok(args[2] && args[2].length > 0, 'non-empty title');
  assert.equal(args[3], '/D');
  assert.equal(args[4], cwd);
  assert.equal(args[5], 'cmd.exe');
  assert.equal(args[6], '/k');
  const run = args[7] ?? '';
  assert.ok(!/cd\s+\/d/i.test(run), run);
  assert.ok(run.includes('grok.exe') && run.includes(`-r ${sid}`), run);
});

test('B12: relaunch script cds with quoted path and runs grok -r', () => {
  const sid = '019fabcd-0000-7000-8000-00000000scr';
  const cwd = 'C:\\Agent-Hub\\grok-remote-control';
  const bin = 'C:\\Users\\sande\\.grok\\bin\\grok.exe';
  const bat = writeWindowsRelaunchScript(cwd, sid, bin);
  try {
    const text = readFileSync(bat, 'utf8');
    assert.match(text, /cd \/d "C:\\Agent-Hub\\grok-remote-control"/);
    assert.ok(text.includes(`-r ${sid}`));
    assert.ok(text.includes('grok.exe'));
  } finally {
    try {
      unlinkSync(bat);
    } catch {
      /* */
    }
  }
});

test('B13: Start-Process command uses WorkingDirectory and grok -r', () => {
  const cmd = windowsStartProcessCommand(
    'C:\\Agent-Hub\\grok-remote-control',
    'abc-123',
    'C:\\Users\\me\\.grok\\bin\\grok.exe'
  );
  assert.match(cmd, /Start-Process/);
  assert.match(cmd, /WorkingDirectory/);
  assert.match(cmd, /-r/);
  assert.match(cmd, /abc-123/);
  assert.ok(!/\bgrokrc\b/.test(cmd));
});

test('PowerShell resume invokes grok -r, not grokrc', () => {
  const cmd = windowsPowerShellResumeCommand(
    'C:\\Agent-Hub\\proj',
    'abc-123',
    'C:\\Users\\me\\.grok\\bin\\grok.exe'
  );
  assert.match(cmd, /Set-Location/);
  assert.match(cmd, /grok\.exe/);
  assert.ok(!/grokrc/.test(cmd));
});
