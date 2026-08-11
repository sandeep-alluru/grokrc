/**
 * The guard verifier is itself a detector, so it has to be shown capable of failing.
 *
 * `tools/verify-guards.mjs` exists because nine isolation proofs lived only as
 * sentences in commit messages. Replacing prose with a script only helps if the
 * script actually notices when a control is dead — otherwise it is a green tick
 * that means nothing, which is precisely the failure it was built to catch.
 *
 * Three properties, each with a fixture registry:
 *
 *   · a mutation that changes no behaviour must NOT count as proven
 *   · a `find` pattern matching nothing must be reported, never silently skipped
 *   · source files must come back byte-for-byte, including after a failing run
 *
 * The last one matters most: this tool edits the working tree. A crash that
 * leaves a mutated source file behind is worse than any check it performs.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = resolve(ROOT, 'tools/verify-guards.mjs');
const TOUCHED = resolve(ROOT, 'src/daemon/events.ts');

async function runVerifier(registry: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [RUNNER, '--registry', resolve(ROOT, registry)],
      { cwd: ROOT, timeout: 180_000 }
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

test('a control that changes no behaviour is reported as unproven', async () => {
  const before = await readFile(TOUCHED, 'utf8');
  const { code, stdout } = await runVerifier('test/fixtures/guards-nonloadbearing.mjs');

  assert.equal(code, 1, `a comment-only mutation must not pass:\n${stdout}`);
  assert.match(stdout, /STILL PASSES|test passes without the control/);
  assert.match(stdout, /fixture-comment-only/);

  // And the file it edited must be exactly as it was.
  assert.equal(await readFile(TOUCHED, 'utf8'), before, 'source not restored after a failing run');
});

test('a find pattern that matches nothing is reported, not skipped', async () => {
  const before = await readFile(TOUCHED, 'utf8');
  const { code, stdout } = await runVerifier('test/fixtures/guards-drift.mjs');

  assert.equal(code, 1, `pattern drift must fail the run:\n${stdout}`);
  assert.match(stdout, /PATTERN DRIFT/);
  // Reporting 0 matches is the whole point — a silent skip reads as success.
  assert.match(stdout, /found 0/);
  assert.equal(await readFile(TOUCHED, 'utf8'), before, 'a drifted guard must not edit anything');
});

test('--list names every real guard without touching the tree', async () => {
  const before = await readFile(TOUCHED, 'utf8');
  const { stdout } = await execFileAsync(process.execPath, [RUNNER, '--list'], { cwd: ROOT });

  const { GUARDS } = (await import('../tools/guards.mjs')) as {
    GUARDS: Array<{ id: string; file: string; test: string; why: string }>;
  };
  assert.ok(
    GUARDS.length >= 10,
    `expected the real registry to be populated, got ${GUARDS.length}`
  );
  for (const g of GUARDS) {
    assert.match(stdout, new RegExp(g.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(await readFile(TOUCHED, 'utf8'), before);
});

test('every registered guard names a file and test that exist', async () => {
  // A registry entry pointing at a moved file would report as drift forever
  // without anyone noticing which half was wrong.
  const { GUARDS } = (await import('../tools/guards.mjs')) as {
    GUARDS: Array<{ id: string; file: string; test: string; find: string; count?: number }>;
  };
  const seen = new Set<string>();
  for (const g of GUARDS) {
    assert.ok(!seen.has(g.id), `duplicate guard id: ${g.id}`);
    seen.add(g.id);

    const src = await readFile(resolve(ROOT, g.file), 'utf8').catch(() => null);
    assert.ok(src, `${g.id}: file not found — ${g.file}`);
    await readFile(resolve(ROOT, g.test), 'utf8').catch(() => {
      throw new Error(`${g.id}: test not found — ${g.test}`);
    });

    // The SAME matcher the runner uses, not a second copy of it. When this test
    // reimplemented the count, the two disagreed about CRLF and the test failed
    // on Windows while the tool it checks was working correctly.
    const { countMatches } = await import('../tools/guard-match.mjs');
    const found = countMatches(src!, g.find);
    assert.equal(
      found,
      g.count ?? 1,
      `${g.id}: pattern matches ${found} time(s), registry expects ${g.count ?? 1}`
    );
  }
});
