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
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { GUARDS } = await import(
  registryPath.startsWith('/') ? registryPath : resolve(process.cwd(), registryPath)
);
const guards = only ? GUARDS.filter((g) => only.includes(g.id)) : GUARDS;

if (argv.includes('--list')) {
  for (const g of GUARDS) console.log(`${g.id}\n    ${g.file} -> ${g.test}\n    ${g.why}`);
  process.exit(0);
}

/* ─── restore safety net ──────────────────────────────────────────────────── */

/** file -> original contents, for everything currently mutated. */
const dirty = new Map();

async function restoreAll() {
  for (const [file, original] of dirty) {
    try {
      await writeFile(join(ROOT, file), original);
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
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, 'tools/isolated-test.mjs'),
        '--test',
        '--experimental-strip-types',
        '--test-concurrency=1',
        testFile,
      ],
      { cwd: ROOT, stdio: 'ignore' }
    );
    child.on('close', (code) => res(code === 0));
    child.on('error', () => res(false));
  });
}

/* ─── the check ───────────────────────────────────────────────────────────── */

const baseline = new Map(); // test file -> passed?
const results = [];

console.log(`\n  verifying ${guards.length} guard(s)\n`);

try {
  for (const g of guards) {
    const label = g.id.padEnd(36);
    const abs = join(ROOT, g.file);
    const original = await readFile(abs, 'utf8');
    const want = g.count ?? 1;
    const found = original.split(g.find).length - 1;

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
      const passed = await runTest(g.test);
      baseline.set(g.test, passed);
      console.log(passed ? 'pass' : 'FAIL');
    }
    if (!baseline.get(g.test)) {
      console.log(`  ✗ ${label} BASELINE FAILS — ${g.test} does not pass unmutated`);
      results.push({ ...g, ok: false, reason: 'baseline failing' });
      continue;
    }

    // MUTATE
    dirty.set(g.file, original);
    await writeFile(abs, original.split(g.find).join(g.replace));

    process.stdout.write(`  · ${label} disabling … `);
    const stillPasses = await runTest(g.test);

    // RESTORE, and prove it
    await writeFile(abs, original);
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
console.log(`\n  ${results.length - bad.length}/${results.length} guard(s) proven load-bearing`);

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
