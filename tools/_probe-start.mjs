import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const flag = join(tmpdir(), 'grokrc-direct-test.flag');
const bat = join(tmpdir(), 'grokrc-direct-test.cmd');
try {
  unlinkSync(flag);
} catch {
  /* */
}
writeFileSync(
  bat,
  [
    '@echo off',
    'title Grok hand-back',
    `echo alive>"${flag}"`,
    'timeout /t 4 /nobreak >nul',
    '',
  ].join('\r\n')
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryMethod(name, fn) {
  try {
    unlinkSync(flag);
  } catch {
    /* */
  }
  fn();
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (existsSync(flag)) {
      console.log(name, 'OK');
      return true;
    }
  }
  console.log(name, 'FAIL');
  return false;
}

// 1: Start-Process -FilePath 'bat' only single quotes
await tryMethod('A Start-Process FilePath bat', () => {
  const q = `'${bat.replace(/'/g, "''")}'`;
  const ps = `Start-Process -FilePath ${q} -WindowStyle Normal`;
  console.log(' ', ps);
  const c = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  c.unref();
});

// 2: cmd /c start "Grok" bat  (quoted title as one argv with quotes inside)
await tryMethod('B start quoted-title argv', () => {
  const c = spawn('cmd.exe', ['/c', 'start', '"Grok"', bat], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  c.unref();
});

// 3: cmd /c start Grok bat (unquoted title)
await tryMethod('C start unquoted-title', () => {
  const c = spawn('cmd.exe', ['/c', 'start', 'Grok', bat], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  c.unref();
});

// 4: shell:true start "Grok" "bat"
await tryMethod('D shell start quoted', () => {
  const c = spawn(`start "Grok" "${bat}"`, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: true,
  });
  c.unref();
});

// 5: direct spawn of cmd /c bat (same console — may not show window)
await tryMethod('E spawn cmd /c bat hide false', () => {
  const c = spawn('cmd.exe', ['/c', bat], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  c.unref();
});

// 6: Start-Process cmd.exe -ArgumentList '/c','bat' with array form in -Command single-quoted bat only
await tryMethod('F Start-Process cmd /c bat single-quoted', () => {
  const q = `'${bat.replace(/'/g, "''")}'`;
  const ps = `Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c',${q}) -WindowStyle Normal`;
  console.log(' ', ps);
  const c = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  c.unref();
});
