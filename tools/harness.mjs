/**
 * Shared harness for the real-stack tools.
 *
 * Directive 02: one implementation, parameterized by the work item. Three tools
 * (e2e-drive, live-ui-check, resume-check) each rebuilt the same
 * AuthStore + SessionManager + RemoteControlServer block, and four each
 * re-launched a browser. Every fix to that block had to be made N times, and the
 * copies had already begun to drift — one isolated GROK_HOME, the others did not.
 *
 * Everything here operates on the REAL stack (directive 03): a real daemon, real
 * pairing over HTTP, a real browser. Nothing is simulated.
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where screenshots go — and by default, NOT into the repo.
 *
 * The browser test and three real-stack checks all call `page.screenshot()`.
 * Every one of them wrote straight into `docs/screenshots/`, which is tracked,
 * so merely RUNNING the suite left modified binaries in the working tree.
 * Measured: a clean tree plus one `test/browser.test.ts` run produced
 * ` M docs/screenshots/approval.png`. On CI that turned into a hard failure —
 * the guards job ends in `git diff --exit-code`, and the screenshots the guard
 * run had just rewritten made it exit 1.
 *
 * Tests must not mutate tracked files as a side effect of running. Writes go to
 * a scratch directory unless regeneration is asked for explicitly:
 *
 *   npm run shots        # regenerate docs/screenshots on purpose
 *
 * There were also THREE separate `SHOTS = join(ROOT, 'docs/screenshots')`
 * constants — harness, https-e2e-check and browser.test — which is the same
 * duplication rule the rest of this repo is held to. This is now the only one.
 */
export const WRITES_TRACKED_SHOTS = process.env.GROKRC_SHOTS === '1';
export const SHOTS = WRITES_TRACKED_SHOTS
  ? join(ROOT, 'docs/screenshots')
  : join(tmpdir(), 'grokrc-screenshots');

/** Temp dirs created through this module, removed by `cleanup()`. */
const scratch = [];

async function scratchDir(prefix) {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/**
 * An isolated GROK_HOME with prompting turned ON.
 *
 * Grok does not ask for permission by default — `[features] support_permission`
 * is false, and a user config may also set `[ui] permission_mode = "auto"`.
 * Neither takes effect from a project `.grok/config.toml`; both are user-config
 * only. So a tool that needs to observe an approval must supply its own GROK_HOME
 * rather than edit the owner's real one.
 *
 * Credentials are copied so the run does not require a fresh login.
 */
export async function isolatedGrokHome({ prompting = true } = {}) {
  const home = await scratchDir('grokrc-grokhome-');
  const real = join(process.env.HOME, '.grok');

  if (prompting) {
    await writeFile(
      join(home, 'config.toml'),
      '[features]\nsupport_permission = true\n\n[ui]\npermission_mode = "default"\n'
    );
  }
  for (const f of ['auth.json', 'agent_id']) {
    try {
      await writeFile(join(home, f), await readFile(join(real, f)));
    } catch {
      /* optional */
    }
  }
  process.env.GROK_HOME = home;
  return home;
}

/**
 * Boot a real daemon on an ephemeral port with isolated pairing state.
 *
 * `transportFactory` is passed straight through: omit it for a REAL grok agent,
 * supply one to replay captures. The caller decides — this module does not
 * choose a fake on anyone's behalf.
 */
/**
 * Is a real Grok Build installed?
 *
 * The real-stack checks drive an actual agent. On a machine without one — every
 * CI runner — they cannot pass, and failing there says nothing about the
 * product. CONTRIBUTING and ci.yml both claimed these "skip themselves"; they
 * did not, and CI was red on every run for a week because of it.
 *
 * Skipping is only honest if it is LOUD: a silent skip is indistinguishable
 * from a pass, which is exactly how a guard elsewhere in this repo certified a
 * control that did not exist.
 */
export async function hasAgent() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('grok', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Exit 0 with a visible notice when there is no agent to drive. */
export async function skipWithoutAgent(what) {
  if (await hasAgent()) return false;
  console.log(`\n  ─── SKIPPED: ${what} ───`);
  console.log('  No `grok` on PATH, so there is no real agent to drive.');
  console.log('  This check proves nothing here and is not counted as a pass.\n');
  return true;
}

/**
 * Refuse to run against a stale build.
 *
 * bootDaemon loads `dist/`, not `src/`. Editing a source file and re-running a
 * real-stack check therefore tests the PREVIOUS build, silently. That cost six
 * consecutive false "still failing" results on backlog #19 — the fix was
 * already correct and the harness kept reporting the old behaviour, so I kept
 * changing working code.
 *
 * A comment asking the next person to remember `npm run build` would be
 * forgotten the same way. This throws instead.
 */
async function assertBuildIsFresh() {
  const { readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const newestIn = async (dir) => {
    let newest = 0;
    const walk = async (d) => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(ts|js)$/.test(entry.name)) {
          const { mtimeMs } = await stat(full);
          if (mtimeMs > newest) newest = mtimeMs;
        }
      }
    };
    try {
      await walk(dir);
    } catch {
      return 0;
    }
    return newest;
  };

  const src = await newestIn(join(ROOT, 'src'));
  const dist = await newestIn(join(ROOT, 'dist'));
  if (dist === 0) {
    throw new Error('dist/ is missing — run `npm run build` before a real-stack check.');
  }
  if (src > dist) {
    const age = Math.round((src - dist) / 1000);
    throw new Error(
      `dist/ is ${age}s older than src/ — you are about to test the PREVIOUS build. ` +
        'Run `npm run build` first. (This exact trap produced six false results on #19.)'
    );
  }
}

export async function bootDaemon({ transportFactory, defaultCwd, push } = {}) {
  // A REAL grok writes its session history into GROK_HOME and keeps it forever.
  // Two checks ran against the owner's real ~/.grok and left a session behind on
  // every `npm test` — 80 of them accumulated, each pointing at a scratch dir
  // that had since been deleted, and each one able to crash the daemon on resume.
  //
  // Refusing here is the only version of this rule that survives: a comment
  // asking the next tool to remember would be forgotten exactly as these two were.
  if (!transportFactory) {
    // `homedir()`, not `process.env.HOME`. HOME is undefined on Windows, so this
    // resolved to `<cwd>/.grok` — the repo directory — and the guard could never
    // fire for the actual C:\Users\<you>\.grok it exists to protect. The test
    // covering it computed the same wrong path, so it compared two identically
    // wrong values and passed while measuring nothing.
    const real = join(process.env.HOME ?? homedir(), '.grok');
    const home = process.env.GROK_HOME;
    if (!home || resolve(home) === resolve(real)) {
      throw new Error(
        'bootDaemon() with a REAL grok would write sessions into your own ~/.grok ' +
          'and leave them there. Call `await isolatedGrokHome()` before bootDaemon(), ' +
          'or pass a transportFactory.'
      );
    }
  }
  // Only for a REAL agent. `npm test` deliberately runs the mock suite BEFORE
  // `npm run build`, so dist/ is legitimately stale there — and a mocked daemon
  // never exercises the code the staleness would hide. The six false results
  // this guard exists to prevent all came from real-stack checks.
  if (!transportFactory) await assertBuildIsFresh();
  const cfgDir = await scratchDir('grokrc-cfg-');
  process.env.GROKRC_HOME = cfgDir;

  const { AuthStore } = await import('../dist/daemon/auth.js');
  const { SessionManager } = await import('../dist/daemon/session-manager.js');
  const { RemoteControlServer } = await import('../dist/daemon/server.js');

  const workDir = defaultCwd ?? (await scratchDir('grokrc-work-'));

  const auth = new AuthStore();
  await auth.load();
  const sessions = new SessionManager(transportFactory ? { transportFactory } : {});
  const server = new RemoteControlServer({
    host: '127.0.0.1',
    port: 0,
    webRoot: join(ROOT, 'web'),
    sessions,
    auth,
    push,
    defaultCwd: workDir,
  });
  const { port } = await server.listen();

  return {
    auth,
    sessions,
    server,
    workDir,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      sessions.closeAll();
      await server.close();
    },
  };
}

/** Pair a device against a running daemon and return its token. */
export async function pairDevice(base, auth, deviceName = 'harness') {
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName }),
  });
  if (!res.ok) throw new Error(`pairing failed: ${res.status}`);
  return (await res.json()).token;
}

/**
 * A real Chromium at phone width, already paired and sitting on the session list.
 *
 * Console errors and uncaught page errors are collected rather than ignored —
 * a silent console error is how a client-side fault hides behind a green run.
 */
export async function pairedPage({ base, auth, origin, code } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['notifications'],
  });
  const page = await ctx.newPage();

  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

  const target = origin ?? base;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#v-pair.on', { timeout: 20_000 });

  const pairingCode = code ?? auth.beginPairing().code;
  await page.fill('#code', pairingCode);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 25_000 });

  await mkdir(SHOTS, { recursive: true });
  return {
    browser,
    page,
    problems,
    async close() {
      await browser.close();
    },
  };
}

/** Consistent pass/fail reporting across tools. */
export function reporter() {
  const problems = [];
  return {
    problems,
    note(ok, msg) {
      console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
      if (!ok) problems.push(msg);
    },
    finish(label = '') {
      console.log(
        `\n─── ${problems.length ? `${problems.length} PROBLEM(S)` : 'ALL CLEAR'} ${label}───`
      );
      for (const p of problems) console.log(`  · ${p}`);
      // Set it here as well as returning it. A caller that writes `finish()`
      // and drops the value produces a check that CANNOT FAIL — which is
      // exactly what happened: midturn-check printed three problems while
      // `npm test` exited 0. Returning a code only works if someone uses it.
      const code = problems.length ? 1 : 0;
      if (code) process.exitCode = code;
      return code;
    },
  };
}

/** Remove every scratch dir this module created. */
export async function cleanup() {
  for (const d of scratch.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}
