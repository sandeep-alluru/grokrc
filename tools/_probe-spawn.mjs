import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ps1 = join(tmpdir(), 'grokrc-spawn-test2.ps1');
writeFileSync(
  ps1,
  [
    `$Host.UI.RawUI.WindowTitle = 'Grok hand-back'`,
    `Write-Host 'HELLO BANNER' -ForegroundColor Green`,
    `Start-Sleep -Seconds 15`,
  ].join('\r\n'),
  'utf8'
);

function aliveMatching(needle) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }"`,
      { encoding: 'utf8', timeout: 10000 }
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// A: direct spawn -File windowsHide false
{
  const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  console.log('A spawn-ps1-file pid', c.pid);
  c.unref();
  await sleep(2000);
  console.log('A still matching', aliveMatching('grokrc-spawn-test2'));
}

// B: Start-Process via -Command with single-quoted -File
{
  const quoted = `'${ps1.replace(/'/g, "''")}'`;
  const cmd =
    `Start-Process -FilePath 'powershell.exe' ` +
    `-ArgumentList @('-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File',${quoted}) ` +
    `-WindowStyle Normal`;
  console.log('B cmd', cmd);
  const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  console.log('B helper pid', c.pid);
  c.unref();
  await sleep(2500);
  console.log('B still matching', aliveMatching('grokrc-spawn-test2'));
}

// C: cmd start with non-empty title
{
  const c = spawn(
    'cmd.exe',
    [
      '/c',
      'start',
      'GrokHandback',
      'powershell.exe',
      '-NoExit',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps1,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  console.log('C cmd-start pid', c.pid);
  c.unref();
  await sleep(2500);
  console.log('C still matching', aliveMatching('grokrc-spawn-test2'));
}

// D: spawn with shell and start
{
  const c = spawn(
    `start "GrokHandback" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: true,
    }
  );
  console.log('D shell-start pid', c.pid);
  c.unref();
  await sleep(2500);
  console.log('D still matching', aliveMatching('grokrc-spawn-test2'));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
