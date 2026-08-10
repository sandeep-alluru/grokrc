/**
 * What someone sees on the day they install this.
 *
 * Found by installing the published package into a fresh HOME with no Grok and
 * no credentials — a state the author's machine can never be in, and which every
 * other check in this repo silently assumed away:
 *
 *   · `grokrc up` started normally with NO agent installed. It printed a config
 *     warning and began listening, so a new user paired a phone to a daemon that
 *     could not open a single session, and only found out later.
 *
 *   · `grokrc doctor`, run logged out, printed the agent's own words —
 *     "Authentication required (-32000)" — which is accurate and names no
 *     command. The one thing the user needed was `grok login`.
 *
 * Both are onboarding failures, invisible to anyone already set up.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = resolve(import.meta.dirname, '../src/cli.ts');

/** A PATH with no `grok` on it, and a HOME with no credentials. */
async function runBare(
  args: string[],
  opts: { withGrok?: string } = {}
): Promise<{ code: number; out: string }> {
  const home = await mkdtemp(join(tmpdir(), 'grokrc-onboard-'));
  const path = opts.withGrok ? `${opts.withGrok}:/usr/bin:/bin` : '/usr/bin:/bin';
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', CLI, ...args],
      {
        env: {
          PATH: path,
          HOME: home,
          GROKRC_HOME: join(home, '.grokrc'),
          GROK_HOME: join(home, '.grok'),
        },
        timeout: 60_000,
      }
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      out: (e.stdout ?? '') + (e.stderr ?? ''),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('`up` refuses to start when the agent is not installed', async () => {
  const { code, out } = await runBare(['up', '--port', '4491']);

  assert.notEqual(code, 0, `up exited 0 with no agent installed:\n${out}`);
  assert.match(
    out,
    /grok not found/i,
    `up must say the agent is missing rather than listening anyway. Got:\n${out}`
  );
  assert.match(out, /x\.ai\/cli\/install\.sh/, 'it should say how to install it');
  assert.doesNotMatch(
    out,
    /listening on/i,
    'a daemon with no agent must not announce itself as ready'
  );
});

test('`doctor` names the missing agent, and how to install it', async () => {
  const { code, out } = await runBare(['doctor']);
  assert.notEqual(code, 0);
  assert.match(out, /grok not found/i);
  assert.match(out, /install: curl/i);
  assert.doesNotMatch(out, /Cannot find module|ERR_[A-Z]|at Object\./, 'no stack traces');
});

test('`doctor` tells a logged-out user which command to run', async () => {
  // Needs a real agent binary that has no credentials in this HOME.
  const { existsSync } = await import('node:fs');
  const real = (process.env.PATH ?? '')
    .split(':')
    .find((dir) => dir && existsSync(join(dir, 'grok')));
  // No agent installed here: nothing to assert against, and saying so beats a
  // hard-coded path to one machine's home directory.
  if (!real) return;

  const { out } = await runBare(['doctor'], { withGrok: real });
  assert.match(out, /grok found/i, `the agent should be discovered on PATH:\n${out}`);
  assert.match(
    out,
    /grok login/,
    `an auth failure must name the command that fixes it, not just relay the agent's error:\n${out}`
  );
});

test('`config` surfaces the one setting with no default', async () => {
  // defaultCwd deliberately has no default — grokrc will not guess where to run
  // an agent that can modify files. That has to be visible, not silent.
  const { out } = await runBare(['config']);
  assert.match(out, /defaultCwd/i, `config must mention the required setting:\n${out}`);
});
