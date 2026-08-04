/**
 * Settings file: precedence, validation, and the deliberate absence of a
 * default working directory.
 *
 * This exists because of a real failure: the systemd service ran with no
 * `--cwd`, so `process.cwd()` was the user's HOME. Every session started from
 * the phone opened there instead of in a project, and the agent began with no
 * repo in context. Flags could not fix it — under systemd there is no shell to
 * `cd` in.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-config-'));
process.env.GROKRC_HOME = tmp;

const {
  loadConfig,
  saveConfig,
  validateConfig,
  coerceValue,
  isKnownKey,
  configPath,
  missingCwdNotice,
  CONFIG_KEYS,
} = await import('../src/daemon/config.ts');

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test('a missing config file is empty, not an error', async () => {
  assert.deepEqual(await loadConfig(), {});
});

test('round-trips through disk', async () => {
  await saveConfig({ defaultCwd: '/tmp', port: 5000 });
  const cfg = await loadConfig();
  assert.equal(cfg.defaultCwd, '/tmp');
  assert.equal(cfg.port, 5000);
});

test('unknown keys in the file are ignored, not surfaced', async () => {
  // A typo shouldn't quietly become a setting nobody reads.
  await mkdir(tmp, { recursive: true });
  await writeFile(configPath(), JSON.stringify({ defaultCwd: '/tmp', typoKey: 'x' }));
  const cfg = await loadConfig();
  assert.equal(cfg.defaultCwd, '/tmp');
  assert.equal((cfg as Record<string, unknown>).typoKey, undefined);
});

test('malformed JSON degrades to empty rather than crashing the daemon', async () => {
  await writeFile(configPath(), '{ not valid json');
  assert.deepEqual(await loadConfig(), {});
});

/* ─── validation ──────────────────────────────────────────────────────────── */

test('a relative defaultCwd is rejected', () => {
  const issues = validateConfig({ defaultCwd: 'relative/path' });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /absolute/);
});

test('a nonexistent defaultCwd is rejected rather than silently ignored', () => {
  // Falling back would reintroduce exactly the surprise this file removes.
  const issues = validateConfig({ defaultCwd: '/definitely/not/here/at/all' });
  assert.match(issues[0]!.message, /does not exist/);
});

test('a file used as defaultCwd is rejected', () => {
  const issues = validateConfig({ defaultCwd: configPath() });
  assert.match(issues[0]!.message, /not a directory/);
});

test('an existing directory is accepted', () => {
  assert.deepEqual(validateConfig({ defaultCwd: tmp }), []);
});

for (const bad of [0, 70000, 1.5, -1]) {
  test(`port ${bad} is rejected`, () => {
    assert.equal(validateConfig({ port: bad }).length, 1);
  });
}

test('a negative historyLimit is rejected', () => {
  assert.equal(validateConfig({ historyLimit: -3 }).length, 1);
});

test('historyLimit 0 is valid — it means "show no history"', () => {
  assert.deepEqual(validateConfig({ historyLimit: 0 }), []);
});

/* ─── CLI coercion ────────────────────────────────────────────────────────── */

test('numeric keys coerce from strings', () => {
  assert.equal(coerceValue('port', '4319'), 4319);
  assert.equal(coerceValue('historyLimit', '25'), 25);
});

test('boolean keys coerce from strings', () => {
  assert.equal(coerceValue('lan', 'true'), true);
  assert.equal(coerceValue('lan', '1'), true);
  assert.equal(coerceValue('lan', 'false'), false);
  assert.equal(coerceValue('leader', 'no'), false);
});

test('string keys pass through unchanged', () => {
  assert.equal(coerceValue('model', 'grok-4.5'), 'grok-4.5');
});

test('only known keys are settable', () => {
  for (const k of CONFIG_KEYS) assert.equal(isKnownKey(k), true);
  assert.equal(isKnownKey('defaultCwdd'), false);
  assert.equal(isKnownKey('__proto__'), false);
});

test('the missing-cwd notice names the command that fixes it', () => {
  const notice = missingCwdNotice();
  assert.match(notice, /grokrc config set defaultCwd/);
});
