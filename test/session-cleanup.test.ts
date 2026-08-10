/**
 * `doctor` creates a throwaway session, and must remove it.
 *
 * Without this, every diagnostic run left a session behind: the owner's history
 * grew by one on each `grokrc doctor`, and those sessions later became
 * unresumable clutter pointing at directories that no longer existed.
 *
 * The interesting half is the refusal. `removeSessionDir` builds a path from a
 * session id and a cwd — both of which arrive from outside — and then deletes
 * it recursively. A traversing id must not be able to walk out of the session
 * store, or a diagnostic command becomes an arbitrary-delete primitive.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'grokrc-cleanup-'));
process.env.GROK_HOME = home;

const { removeSessionDir } = await import('../src/cli.ts');

const exists = async (p: string) =>
  await stat(p)
    .then(() => true)
    .catch(() => false);

test('removes the session directory it created', async () => {
  const cwd = '/tmp/some-project';
  const id = '019fabcd-1111-7000-8000-000000000001';
  const dir = join(home, 'sessions', encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'updates.jsonl'), '{}\n');

  assert.equal(await exists(dir), true, 'precondition: the session exists');
  await removeSessionDir(id, cwd);
  assert.equal(await exists(dir), false, 'doctor left its throwaway session behind');
});

test('refuses a session id that escapes the session store', async () => {
  // The canary: something outside the store that must survive.
  const canary = join(home, 'auth.json');
  await writeFile(canary, '{"devices":[]}');

  const cwd = '/tmp/some-project';
  for (const evil of ['../../..', '../../../auth.json', '..', '../..']) {
    await removeSessionDir(evil, cwd);
  }

  assert.equal(
    await exists(canary),
    true,
    'a traversing session id deleted a file outside the session store'
  );
  assert.equal(await exists(home), true, 'the Grok home itself was removed');
});

test('a non-existent session is a no-op, not a throw', async () => {
  // doctor calls this on a best-effort basis; a failure to tidy up must never
  // fail the diagnostic itself.
  await removeSessionDir('019fabcd-2222-7000-8000-000000000002', '/tmp/never-existed');
});

test.after?.(async () => {
  await rm(home, { recursive: true, force: true });
});
