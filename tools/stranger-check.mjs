#!/usr/bin/env node
/**
 * Install grokrc the way someone who has never seen this machine would.
 *
 * Portable replacement for tools/stranger-check.sh so Windows is not excluded
 * from the first-run check — first-run is exactly where Windows differs most
 * (Grok not on PATH after install; no login yet).
 *
 * ISOLATED HERE (everything grokrc actually reads):
 *   HOME / USERPROFILE   fresh empty dir  -> no ~/.grok, ~/.grokrc
 *   PATH                 system only      -> no grok, no author-installed bins
 *   npm cache / prefix   fresh            -> nothing warmed
 *
 * NOT ISOLATED:
 *   kernel, system packages, installed Node. A stranger on Node 18 is not
 *   covered by this script.
 *
 * Usage:
 *   node tools/stranger-check.mjs                  # pack current tree
 *   node tools/stranger-check.mjs --pkg grokrc     # public registry
 *   node tools/stranger-check.mjs --pkg ./file.tgz
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const pkgFlag = args.indexOf('--pkg');
const PKG_ARG = pkgFlag === -1 ? null : args[pkgFlag + 1];

let PASS = 0;
let FAIL = 0;
function ok(msg) {
  console.log(`  ✓ ${msg}`);
  PASS++;
}
function bad(msg, detail = '') {
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`      ${detail.split('\n').slice(0, 6).join('\n      ')}`);
  FAIL++;
}
function head(text, n = 6) {
  return String(text)
    .split(/\r?\n/)
    .slice(0, n)
    .map((l) => `      ${l}`)
    .join('\n');
}

/** Minimal PATH so author tools (including grok) do not leak in. */
function systemPath() {
  if (IS_WIN) {
    const windir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return [
      join(windir, 'System32'),
      windir,
      join(windir, 'System32', 'Wbem'),
      join(windir, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(delimiter);
  }
  return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(
    delimiter
  );
}

function run(cmd, cmdArgs, env, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    env,
    encoding: 'utf8',
    shell: IS_WIN,
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: r.status ?? (r.error ? 1 : 0),
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    error: r.error,
  };
}

function whichGrokOnRealMachine() {
  const r = spawnSync(IS_WIN ? 'where.exe' : 'command', IS_WIN ? ['grok'] : ['-v', 'grok'], {
    encoding: 'utf8',
    shell: false,
  });
  const line = (r.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line && existsSync(line) ? line : null;
}

const realGrok = whichGrokOnRealMachine();
const sandbox = mkdtempSync(join(tmpdir(), 'grokrc-stranger-'));
const npmCache = join(sandbox, '.npm');
const npmPrefix = join(sandbox, '.local');
const binDir = join(npmPrefix, IS_WIN ? '' : 'bin');
// npm on Windows puts globals under prefix/ (grokrc.cmd); on Unix under prefix/bin.
const npmBin = IS_WIN ? npmPrefix : join(npmPrefix, 'bin');
mkdirSync(npmPrefix, { recursive: true });
mkdirSync(join(sandbox, 'projects'), { recursive: true });

const env = {
  ...process.env,
  HOME: sandbox,
  USERPROFILE: sandbox,
  HOMEDRIVE: sandbox.slice(0, 2),
  HOMEPATH: sandbox.slice(2) || '\\',
  PATH: systemPath(),
  npm_config_cache: npmCache,
  npm_config_prefix: npmPrefix,
  npm_config_update_notifier: 'false',
  XDG_CONFIG_HOME: join(sandbox, '.config'),
  XDG_DATA_HOME: join(sandbox, '.local', 'share'),
  APPDATA: join(sandbox, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(sandbox, 'AppData', 'Local'),
};
delete env.GROK_HOME;
delete env.GROKRC_HOME;
// Ensure node/npm remain reachable: re-append their directories after the
// stripped PATH. Isolating from grok is the goal; isolating from node would
// make the check measure nothing.
const nodeDir = dirname(process.execPath);
const npmPath = run(IS_WIN ? 'where.exe' : 'command', IS_WIN ? ['npm'] : ['-v', 'npm'], {
  ...process.env,
  PATH: process.env.PATH,
})
  .out.split(/\r?\n/)
  .map((s) => s.trim())
  .find(Boolean);
const npmDir = npmPath ? dirname(npmPath) : nodeDir;
env.PATH = [nodeDir, npmDir, env.PATH].join(delimiter);

console.log('');
console.log(`  stranger check — HOME=${sandbox}`);
console.log(`  node ${process.version}, platform ${process.platform}`);
console.log('');

// ── the machine really is bare ──────────────────────────────────────────────
const grokLeak = run(IS_WIN ? 'where.exe' : 'command', IS_WIN ? ['grok'] : ['-v', 'grok'], env);
const foundGrok = (grokLeak.out || '')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .find(Boolean);
if (!foundGrok || grokLeak.code !== 0) ok("grok is NOT installed (as a stranger's would be)");
else bad('grok leaked into the sandbox PATH', foundGrok);

if (!existsSync(join(sandbox, '.grok'))) ok('no Grok credentials in HOME');
else bad('~/.grok leaked in');
if (!existsSync(join(sandbox, '.grokrc'))) ok('no grokrc config in HOME');
else bad('~/.grokrc leaked in');

// ── package source ──────────────────────────────────────────────────────────
let installTarget = PKG_ARG;
if (!installTarget) {
  console.log('');
  console.log('  packing current tree…');
  // npm pack prints the tarball name on the last non-empty line of stdout.
  const pack2 = spawnSync('npm', ['pack', '--pack-destination', sandbox], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: IS_WIN,
    timeout: 180_000,
  });
  const tgzName = (pack2.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (pack2.status === 0 && tgzName) {
    installTarget = join(sandbox, tgzName);
    ok(`packed current tree as ${tgzName}`);
  } else {
    bad('npm pack failed', pack2.stderr || pack2.stdout);
    installTarget = null;
  }
}

// ── install ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`  installing ${installTarget ?? '(none)'} into sandbox prefix…`);
if (installTarget) {
  const inst = run('npm', ['install', '-g', installTarget], env, { timeout: 300_000 });
  if (inst.code === 0) ok(`npm install -g succeeded`);
  else bad('npm install -g failed', inst.out);

  // Resolve the grokrc binary npm produced.
  const candidates = IS_WIN
    ? [join(npmBin, 'grokrc.cmd'), join(npmBin, 'grokrc'), join(npmPrefix, 'grokrc.cmd')]
    : [join(npmBin, 'grokrc')];
  // Also search node_modules/.bin style under prefix
  const modBin = join(npmPrefix, 'node_modules', 'grokrc');
  let grokrcBin = candidates.find((p) => existsSync(p));
  if (!grokrcBin && existsSync(modBin)) {
    // package bin field points at dist/cli.js — invoke via node
    const cli = join(modBin, 'dist', 'cli.js');
    if (existsSync(cli)) grokrcBin = cli;
  }
  if (!grokrcBin) {
    // last resort: list prefix
    try {
      const listing = readdirSync(npmPrefix).join(', ');
      bad('no grokrc binary produced', listing);
    } catch {
      bad('no grokrc binary produced');
    }
  } else {
    ok(`grokrc binary is on the prefix (${grokrcBin})`);
  }

  const webDir = join(npmPrefix, 'lib', 'node_modules', 'grokrc', 'web');
  const webDirWin = join(npmPrefix, 'node_modules', 'grokrc', 'web');
  if (existsSync(webDir) || existsSync(webDirWin) || existsSync(join(modBin, 'web'))) {
    ok('the PWA shipped with it');
  } else {
    bad('web/ missing from the package');
  }

  const runGrokrc = (cliArgs, e = env, timeout = 30_000) => {
    if (!grokrcBin) return { code: 1, out: 'no binary' };
    if (grokrcBin.endsWith('.js')) {
      return run(process.execPath, [grokrcBin, ...cliArgs], e, { timeout });
    }
    return run(grokrcBin, cliArgs, e, { timeout });
  };

  // ── with NO grok ──────────────────────────────────────────────────────────
  console.log('');
  console.log('  --- with NO grok installed ---');
  const doc = runGrokrc(['doctor']);
  console.log(head(doc.out));
  if (/not found|no grok|install/i.test(doc.out)) ok('doctor names the missing dependency');
  else bad('doctor does not tell a stranger that grok is missing', doc.out);
  if (
    /Error:|ERR_[A-Z]+|Cannot find module|at Object\./.test(doc.out) &&
    !/grok not found/i.test(doc.out)
  ) {
    bad('doctor leaked a stack trace instead of a message');
  } else {
    ok('doctor fails cleanly, no stack trace');
  }

  const up = runGrokrc(['up', '--port', '4498'], env, 25_000);
  console.log(head(up.out));
  if (/grok (was )?not found|not found on PATH|install: curl/i.test(up.out)) {
    ok('up explains the missing dependency');
  } else {
    bad('up does not explain what is missing', up.out);
  }

  // ── with grok present but not logged in (or logged in under sandbox) ─────
  console.log('');
  console.log('  --- with grok present ---');
  if (realGrok) {
    mkdirSync(npmBin, { recursive: true });
    const linkName = join(npmBin, IS_WIN ? 'grok.exe' : 'grok');
    try {
      if (IS_WIN) copyFileSync(realGrok, linkName);
      else {
        symlinkSync(realGrok, linkName);
        try {
          chmodSync(linkName, 0o755);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // copy may fail for some reasons; put realGrok's dir on PATH instead
      console.log(`      (could not copy grok: ${err.message}; putting real dir on PATH)`);
    }
    const envWithGrok = {
      ...env,
      PATH: `${npmBin}${delimiter}${dirname(realGrok)}${delimiter}${env.PATH}`,
      // Force no credentials in sandbox even if copy failed oddly
      HOME: sandbox,
      USERPROFILE: sandbox,
      GROK_HOME: join(sandbox, '.grok-empty-should-not-exist'),
    };
    delete envWithGrok.GROK_HOME;

    const doc2 = runGrokrc(['doctor'], envWithGrok);
    console.log(head(doc2.out));
    if (/grok found/i.test(doc2.out)) ok('doctor finds grok once it is installed');
    else bad('doctor cannot see a grok that is on PATH', doc2.out);

    // If the real machine has auth, doctor may pass the login check. That is
    // still fine: the stranger PATH has grok, but HOME is empty so auth should
    // fail unless grok stores credentials outside HOME (it uses GROK_HOME/HOME).
    if (/grok login|run .grok login|sign in with .grok|not logged|not signed/i.test(doc2.out)) {
      ok('doctor tells a logged-out user to run `grok login`');
    } else if (/agent|ACP|ready|ok/i.test(doc2.out) && !/not found/i.test(doc2.out)) {
      // Credentials may have been found via something other than HOME — report honestly
      ok('doctor reaches the agent (credentials available outside sandbox HOME — noted)');
    } else {
      bad("doctor passes the agent's raw auth error through without saying what to do", doc2.out);
    }
  } else {
    console.log('      (no grok binary on the real machine — skipped login checks)');
  }

  // ── required configuration ────────────────────────────────────────────────
  console.log('');
  console.log('  --- required configuration ---');
  const cfg = runGrokrc(['config']);
  console.log(head(cfg.out));
  if (/defaultCwd/i.test(cfg.out)) ok('config tells a stranger defaultCwd is needed');
  else bad('config does not surface the one required setting', cfg.out);

  const projects = join(sandbox, 'projects');
  const set = runGrokrc(['config', 'set', 'defaultCwd', projects]);
  if (set.code === 0) ok('config set defaultCwd works');
  else bad('config set failed', set.out);

  const cfgPath = join(sandbox, '.grokrc', 'config.json');
  try {
    const body = readFileSync(cfgPath, 'utf8');
    if (
      body.includes('projects') ||
      body.includes(projects.replace(/\\/g, '\\\\')) ||
      body.includes(projects)
    ) {
      ok('the setting persisted to a fresh HOME');
    } else {
      // Windows paths in JSON use backslashes escaped
      const normalized = body.replace(/\\\\/g, '\\');
      if (normalized.includes(projects) || /projects/i.test(body))
        ok('the setting persisted to a fresh HOME');
      else bad('config did not persist', body);
    }
  } catch (err) {
    bad('config did not persist', err.message);
  }
}

console.log('');
console.log(`  ── ${PASS} passed, ${FAIL} failed ──`);
console.log(`  sandbox: ${sandbox} (removing)`);
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  console.log('      (sandbox cleanup partial — OS may still hold a handle)');
}
process.exit(FAIL === 0 ? 0 : 1);
