/**
 * Apple rejects a VAPID subject it cannot route, and says nothing useful.
 *
 * Observed against a real iPhone: every push to `web.push.apple.com` returned
 *
 *     push failed (403): Received unexpected response code
 *
 * while the same send to Mozilla succeeded. The cause was the JWT `sub` claim:
 * `mailto:grokrc@localhost`. Apple validates it, Mozilla does not — so this
 * failed on iPhones only, and looked exactly like an iOS permissions problem.
 * Three separate explanations were given to the owner blaming Safari and
 * add-to-home-screen before the real defect was found, in our own code.
 *
 * The subject is part of the signed token, NOT the key pair. Repairing it must
 * therefore leave the keys alone: regenerating them would silently invalidate
 * every existing subscription, which is a worse bug than the one being fixed.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { isRoutableSubject } = await import('../src/daemon/push.ts');

test('rejects subjects Apple will 403', () => {
  for (const bad of [
    'mailto:grokrc@localhost', // the shipped default that broke iOS
    'mailto:someone@localhost',
    'mailto:no-at-sign',
    'mailto:',
    'https://localhost:4319',
    'https://localhost',
    'http://example.com/x', // http is not acceptable
    'grokrc@example.com', // no scheme
    '',
  ]) {
    assert.equal(isRoutableSubject(bad), false, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('accepts subjects that are actually routable', () => {
  for (const ok of [
    'https://github.com/sandeep-alluru/grokrc',
    'https://example.com',
    'mailto:me@example.com',
    'mailto:ops@sub.domain.co.uk',
  ]) {
    assert.equal(isRoutableSubject(ok), true, `should accept: ${JSON.stringify(ok)}`);
  }
});

/**
 * Load a PushService against a throwaway GROKRC_HOME.
 *
 * In a CHILD PROCESS, because `KEYS_PATH` is computed at module load from
 * auth.ts's `CONFIG_DIR`. Setting the env var after that module is resolved
 * changes nothing — an earlier version of this helper did exactly that, read
 * the developer's REAL ~/.grokrc, and reported a pass that meant nothing.
 */
async function loadWith(vapid: Record<string, string>): Promise<{
  home: string;
  subject: string;
  stored: Record<string, string>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'grokrc-vapid-'));
  await writeFile(join(home, 'vapid.json'), JSON.stringify(vapid), { mode: 0o600 });

  const mod = resolve(import.meta.dirname, '../src/daemon/push.ts');
  await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `const { PushService } = await import(${JSON.stringify(mod)});
       const s = new PushService();
       await s.load();`,
    ],
    { env: { ...process.env, GROKRC_HOME: home }, timeout: 60_000 }
  );

  const stored = JSON.parse(await readFile(join(home, 'vapid.json'), 'utf8')) as Record<
    string,
    string
  >;
  return { home, subject: stored.subject!, stored };
}

test('a stored unroutable subject is repaired, and the keys are left alone', async () => {
  const original = {
    publicKey:
      'BAIrW0ganu_3aeJwSRVgfdlUo4luUQ8HSmKHOkajhQSZOcdbJVgxw4BxEEyYAIz3NNWtlram-YIxa7fvhPhMQlc',
    privateKey: 'JmDqmLGgU2iXG9AthLTxJGYaAxrKEjbAJx8XoKa9dGw',
    subject: 'mailto:grokrc@localhost',
  };
  const { home, subject, stored } = await loadWith(original);
  try {
    assert.equal(
      isRoutableSubject(subject),
      true,
      `the broken subject survived load(): ${subject}`
    );
    assert.notEqual(subject, original.subject);

    // The whole point. New keys would invalidate every subscription already
    // registered by every device — a far worse failure than a 403.
    assert.equal(stored.publicKey, original.publicKey, 'public key must not be regenerated');
    assert.equal(stored.privateKey, original.privateKey, 'private key must not be regenerated');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a subject that is already routable is left exactly as configured', async () => {
  // Someone who set a real address must not have it overwritten.
  const mine = {
    publicKey:
      'BAIrW0ganu_3aeJwSRVgfdlUo4luUQ8HSmKHOkajhQSZOcdbJVgxw4BxEEyYAIz3NNWtlram-YIxa7fvhPhMQlc',
    privateKey: 'JmDqmLGgU2iXG9AthLTxJGYaAxrKEjbAJx8XoKa9dGw',
    subject: 'mailto:owner@example.com',
  };
  const { home, subject } = await loadWith(mine);
  try {
    assert.equal(subject, mine.subject, 'a valid custom subject must be preserved');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
