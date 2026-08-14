#!/usr/bin/env node
/**
 * Prove that every load-bearing control is actually load-bearing.
 *
 * A passing test proves nothing on its own — it may exercise nothing. The step
 * that catches that is isolation: disable the control you believe is doing the
 * work, and the test MUST fail again. Nine of those proofs existed in this repo
 * as sentences in commit messages. Sentences do not re-run.
 *
 * For each entry in tools/guards.mjs:
 *
 *   1. BASELINE  run the test unmutated — it has to pass, or the mutation
 *                result means nothing. Cached per test file.
 *   2. DRIFT     the `find` text must occur exactly `count` times. A pattern
 *                that silently matches nothing would report a guard as verified
 *                while changing no code — the same silent no-op that once
 *                shipped a stale README claim.
 *   3. MUTATE    write the disabled form.
 *   4. EXPECT    run the test again; it MUST fail. If it still passes, either
 *                the control is not load-bearing or the test cannot see it.
 *   5. RESTORE   always, and verify the bytes came back.
 *
 * Usage:
 *   node tools/verify-guards.mjs [--registry <path>] [--only <id,id>] [--list]
 *
 * Exits non-zero if any guard is unproven. Source files are edited in place and
 * restored; the process restores on exit, on signal, and on crash.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { countMatches, forSource } from './guard-match.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ─── argv ────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const registryPath = flag('--registry') ?? join(ROOT, 'tools/guards.mjs');
const only = flag('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// `import()` of a path — not a URL. On Windows an absolute path begins `C:\`,
// which the ESM loader reads as a URL scheme and rejects with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, so the guard runner could not start at all
// there. `pathToFileURL` is the supported spelling on every platform. The
// `startsWith('/')` test it replaces was the same POSIX-only "is it absolute?"
// assumption; `resolve()` already leaves an absolute path untouched.
const { GUARDS } = await import(pathToFileURL(resolve(process.cwd(), registryPath)).href);
const guards = only ? GUARDS.filter((g) => only.includes(g.id)) : GUARDS;

if (argv.includes('--list')) {
  for (const g of GUARDS) console.log(`${g.id}\n    ${g.file} -> ${g.test}\n    ${g.why}`);
  process.exit(0);
}

/* ─── restore safety net ──────────────────────────────────────────────────── */

/**
 * file -> { content, atimeMs, mtimeMs } for everything currently mutated.
 *
 * Restoring content with writeFile alone bumps mtime. That made `src/` look
 * newer than `dist/` after test/verify-guards.test.ts (and any suite that runs
 * the verifier), so the next real-stack check refused with "dist is older than
 * src" even when the bytes never changed — the twin of BACKLOG #21, on the
 * suite side. Put the original timestamps back after every restore.
 */
const dirty = new Map();

async function restoreFile(abs, snapshot) {
  await writeFile(abs, snapshot.content);
  await utimes(abs, snapshot.atimeMs / 1000, snapshot.mtimeMs / 1000);
}

async function snapshotFile(abs, content) {
  const st = await stat(abs);
  return { content, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs };
}

async function restoreAll() {
  for (const [file, snapshot] of dirty) {
    try {
      await restoreFile(join(ROOT, file), snapshot);
    } catch {
      console.error(`  !! could not restore ${file} — check \`git diff\``);
    }
  }
  dirty.clear();
}

// A mutated source file left on disk is worse than a failed check. Restore on
// every exit path, including the ones that skip `finally`.
let restoring = false;
const bail = async (why, code) => {
  if (restoring) return;
  restoring = true;
  console.error(`\n  interrupted (${why}) — restoring source files…`);
  await restoreAll();
  process.exit(code);
};
process.on('SIGINT', () => void bail('SIGINT', 130));
process.on('SIGTERM', () => void bail('SIGTERM', 143));
process.on('uncaughtException', (err) => {
  console.error(err);
  void bail('uncaughtException', 1);
});

/* ─── running a test file ─────────────────────────────────────────────────── */

/**
 * Run one test file, isolated the same way `npm test` isolates it.
 * Resolves to true when the file passed.
 */
function runTest(testFile) {
  // Not every control is provable by a `node:test` file. The ACP conformance
  // gate drives a real agent and compares it against a pinned protocol surface,
  // which cannot live in test/*.test.ts — `test:mock` must never spawn an agent,
  // and harness-isolation exists to enforce exactly that. So a guard may name a
  // runnable check instead, and this ONE runner drives both. A second runner
  // per shape is how this file would rot into a copy per guard.
  const isCheck = testFile.endsWith('.mjs');
  const args = isCheck
    ? [join(ROOT, 'tools/isolated-test.mjs'), '--experimental-strip-types', testFile]
    : [
        join(ROOT, 'tools/isolated-test.mjs'),
        '--test',
        '--experimental-strip-types',
        '--test-concurrency=1',
        testFile,
      ];
  return new Promise((res) => {
    // Capture output rather than discarding it: a check that SKIPS itself exits
    // 0, which is indistinguishable from a pass unless you read what it said.
    // That cost a real CI failure — `turn-completion-is-understood` reported
    // "test passes without the control" on every runner, because the runner has
    // no `grok` and the conformance check skipped. The identical trap is already
    // recorded against `doctor-names-the-login-command` in guards.mjs, so this
    // is mechanism debt: fix the runner once, not each guard as it bites.
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) => res({ passed: code === 0, skipped: /─── SKIPPED:/.test(out) }));
    child.on('error', () => res({ passed: false, skipped: false }));
  });
}

/* ─── the check ───────────────────────────────────────────────────────────── */

const baseline = new Map(); // test file -> passed?
const results = [];

console.log(`\n  verifying ${guards.length} guard(s)\n`);

try {
  for (const g of guards) {
    const label = g.id.padEnd(36);

    // A control the current OS never reaches cannot be proven here. Report it
    // as unprovable — the same treatment a self-skipping check gets — instead
    // of failing the run for the platform it is on.
    const here = process.platform === 'win32' ? 'win32' : 'posix';
    if (g.onlyOn && g.onlyOn !== here) {
      console.log(`  · ${label} UNPROVABLE HERE — ${g.onlyOn}-only control, running on ${here}`);
      results.push({ ...g, ok: true, skipped: true });
      continue;
    }
    const abs = join(ROOT, g.file);
    const original = await readFile(abs, 'utf8');
    const want = g.count ?? 1;

    // Line endings are handled in ONE place, shared with the test that checks
    // this registry — see tools/guard-match.mjs for why CRLF is in scope.
    const find = forSource(original, g.find);
    const replace = forSource(original, g.replace);
    const found = countMatches(original, g.find);

    // DRIFT — a pattern matching nothing would "verify" a guard while changing
    // no code at all.
    if (found !== want) {
      console.log(`  ✗ ${label} PATTERN DRIFT — expected ${want} match(es), found ${found}`);
      results.push({ ...g, ok: false, reason: `pattern matched ${found}/${want}` });
      continue;
    }

    // BASELINE — a test that is already failing cannot prove anything.
    if (!baseline.has(g.test)) {
      process.stdout.write(`  · baseline ${g.test} … `);
      const r = await runTest(g.test);
      baseline.set(g.test, r);
      console.log(r.skipped ? 'SKIPPED here' : r.passed ? 'pass' : 'FAIL');
    }
    const base = baseline.get(g.test);
    // A check that cannot run here proves nothing either way. Say so out loud
    // and move on — counting it as proven would be the exact lie this file
    // exists to prevent, and counting it as failed would make CI red for a
    // missing agent rather than a missing control.
    if (base.skipped) {
      console.log(`  · ${label} UNPROVABLE HERE — ${g.test} skips itself in this environment`);
      results.push({ ...g, ok: true, skipped: true });
      continue;
    }
    if (!base.passed) {
      console.log(`  ✗ ${label} BASELINE FAILS — ${g.test} does not pass unmutated`);
      results.push({ ...g, ok: false, reason: 'baseline failing' });
      continue;
    }

    // MUTATE
    dirty.set(g.file, await snapshotFile(abs, original));
    await writeFile(abs, original.split(find).join(replace));

    process.stdout.write(`  · ${label} disabling … `);
    const mutated = await runTest(g.test);
    const stillPasses = mutated.passed && !mutated.skipped;

    // RESTORE content + mtime, and prove content
    const snap = dirty.get(g.file);
    await restoreFile(abs, snap);
    dirty.delete(g.file);
    const after = await readFile(abs, 'utf8');
    if (after !== original) {
      console.log('RESTORE FAILED');
      results.push({ ...g, ok: false, reason: 'restore mismatch' });
      break; // do not touch anything else with a dirty tree
    }

    if (stillPasses) {
      console.log('STILL PASSES  ✗');
      results.push({ ...g, ok: false, reason: 'test passes without the control' });
    } else {
      console.log('test fails  ✓');
      results.push({ ...g, ok: true });
    }
  }
} finally {
  await restoreAll();
}

/* ─── report ──────────────────────────────────────────────────────────────── */

const bad = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const proven = results.length - bad.length - skipped.length;

// Report the three outcomes separately. Folding "unprovable here" into
// "proven" is the same lie as a silent skip: the number would say the control
// was checked on a machine that could not check it.
console.log(`\n  ${proven}/${results.length} guard(s) proven load-bearing`);
if (skipped.length) {
  console.log(`  ${skipped.length} UNPROVABLE in this environment — not counted as proven:`);
  for (const r of skipped) console.log(`    · ${r.id} (${r.test} skips itself here)`);
}

if (bad.length) {
  console.log('\n  UNPROVEN:\n');
  for (const r of bad) {
    console.log(`    ${r.id}  (${r.reason})`);
    console.log(`      ${r.file}  ->  ${r.test}`);
    console.log(`      ${r.why}\n`);
  }
  console.log(
    '  A test that passes with its control disabled is measuring nothing.\n' +
      '  Either the control is dead code, or the test does not exercise it.\n'
  );
  process.exit(1);
}

console.log('  every control is doing work, and its test can see it.\n');
