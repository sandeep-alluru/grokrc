#!/usr/bin/env node
/**
 * Run the test suite under a GROK_HOME of its own, and prove it stayed there.
 *
 * A real `grok` records every session under GROK_HOME and keeps it forever.
 * Several tests spawn a real agent, and the ones that forgot to isolate wrote
 * into the developer's actual `~/.grok` — 80 sessions accumulated there, each
 * pointing at a scratch directory that had since been deleted, and each able to
 * crash the daemon on resume (test/spawn-failure.test.ts).
 *
 * Two mechanisms, because one is not enough:
 *
 *   PREVENT  every test process inherits GROK_HOME pointing at a scratch dir,
 *            so forgetting to isolate costs nothing.
 *   DETECT   the real ~/.grok is counted before and after. If the suite wrote
 *            there anyway — through a subprocess that resets the variable, say —
 *            this exits non-zero and names what leaked.
 *
 * Per-file discipline was tried first and drifted: `isolatedGrokHome()` existed
 * and one of three tools used it.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_SESSIONS = join(process.env.HOME ?? homedir(), '.grok', 'sessions');

/** Every session id currently in the developer's real Grok history. */
async function snapshot() {
  const found = new Set();
  let groups;
  try {
    groups = await readdir(REAL_SESSIONS);
  } catch {
    return found; // no history yet — nothing to protect
  }
  for (const g of groups) {
    const dir = join(REAL_SESSIONS, g);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      for (const s of await readdir(dir)) found.add(`${decodeURIComponent(g)}::${s}`);
    } catch {
      /* raced with a delete, or not a directory */
    }
  }
  return found;
}

const before = await snapshot();
const home = await mkdtemp(join(tmpdir(), 'grokrc-testhome-'));

// Credentials come along, or a real agent cannot log in and the tests that
// genuinely exercise `grok` fail for a reason that has nothing to do with them.
// Same two files `isolatedGrokHome()` copies.
const realHome = join(process.env.HOME ?? homedir(), '.grok');
for (const f of ['auth.json', 'agent_id']) {
  await copyFile(join(realHome, f), join(home, f)).catch(() => {});
}

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, GROK_HOME: home },
});

const code = await new Promise((resolve) => {
  child.on('close', (c) => resolve(c ?? 1));
  child.on('error', () => resolve(1));
});

await rm(home, { recursive: true, force: true });

const after = await snapshot();
const leaked = [...after].filter((s) => !before.has(s));

if (leaked.length) {
  console.error(`\n  ✗ the suite wrote ${leaked.length} session(s) into your real ~/.grok:\n`);
  for (const s of leaked.slice(0, 10)) {
    const [cwd, id] = s.split('::');
    console.error(`      ${id}  cwd=${cwd}`);
  }
  console.error(
    '\n  These outlive their working directory and become unresumable clutter.\n' +
      '  Set GROK_HOME in the offending test before importing the daemon.\n'
  );
  process.exit(1);
}

process.exit(code);
