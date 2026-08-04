/**
 * Preflight: does the agent actually ask before running tools?
 *
 * Grounded in a real finding — end-to-end testing showed Grok Build never sends
 * `session/request_permission` unless `[features] support_permission = true`,
 * and this machine's config additionally had `[ui] permission_mode = "auto"`.
 * Both silently disable remote approval, so absence of config must read as
 * unsafe, never as fine.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPermissionPosture, posturteWarning } from '../src/daemon/preflight.ts';

async function withConfig(toml: string | null) {
  const dir = await mkdtemp(join(tmpdir(), 'preflight-'));
  if (toml !== null) await writeFile(join(dir, 'config.toml'), toml);
  const posture = await checkPermissionPosture(dir);
  await rm(dir, { recursive: true, force: true });
  return posture;
}

test('a missing config is treated as NOT prompting', async () => {
  // The default is false; silence must not be read as safety.
  const p = await withConfig(null);
  assert.equal(p.willPrompt, false);
  assert.equal(p.supportPermission, null);
  assert.match(p.reasons.join(' '), /defaults to false/);
});

test('support_permission = true alone is enough', async () => {
  const p = await withConfig('[features]\nsupport_permission = true\n');
  assert.equal(p.willPrompt, true);
  assert.equal(posturteWarning(p), null);
});

test('support_permission = false is reported', async () => {
  const p = await withConfig('[features]\nsupport_permission = false\n');
  assert.equal(p.willPrompt, false);
  assert.match(p.reasons.join(' '), /support_permission = false/);
});

test('a non-prompting permission_mode defeats support_permission', async () => {
  // Exactly this machine's real configuration.
  const p = await withConfig(
    '[features]\nsupport_permission = true\n\n[ui]\npermission_mode = "auto"\n'
  );
  assert.equal(p.willPrompt, false);
  assert.match(p.reasons.join(' '), /permission_mode = "auto"/);
});

for (const mode of ['auto', 'dontAsk', 'bypassPermissions', 'acceptEdits']) {
  test(`permission_mode "${mode}" is flagged`, async () => {
    const p = await withConfig(
      `[features]\nsupport_permission = true\n\n[ui]\npermission_mode = "${mode}"\n`
    );
    assert.equal(p.willPrompt, false);
  });
}

test('permission_mode "default" prompts', async () => {
  const p = await withConfig(
    '[features]\nsupport_permission = true\n\n[ui]\npermission_mode = "default"\n'
  );
  assert.equal(p.willPrompt, true);
});

test('keys are read from the right section, not anywhere in the file', async () => {
  // A `support_permission` under some other table must not count.
  const p = await withConfig(
    '[somethingelse]\nsupport_permission = true\n\n[ui]\nmax_thoughts_width = 120\n'
  );
  assert.equal(p.willPrompt, false);
});

test('the warning names the config path and the fix', async () => {
  const p = await withConfig('[features]\nsupport_permission = false\n');
  const w = posturteWarning(p) ?? '';
  assert.match(w, /WILL NOT ASK/);
  assert.match(w, /support_permission = true/);
  assert.match(w, /config\.toml/);
});
