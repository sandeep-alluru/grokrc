/**
 * A session that cannot be spawned must not take down the daemon.
 *
 * Observed in production on 2026-08-05: the service died twice in 45 seconds
 * while the owner was tapping around the session list.
 *
 *   Error: spawn grok ENOENT
 *   Emitted 'error' event on AcpClient instance at:
 *   grokrc.service: Main process exited, code=exited, status=1/FAILURE
 *
 * Two defects, one symptom:
 *
 *  1. Node reports `spawn <cmd> ENOENT` when the **cwd** does not exist, not
 *     only when the binary is missing. Nothing validated that a session's
 *     recorded cwd still exists before spawning there, so any session whose
 *     directory had been deleted was a live grenade in the list. 92 such
 *     sessions existed on the owner's machine.
 *
 *  2. `AcpClient` re-emits transport errors, and an 'error' event with no
 *     listener is THROWN by Node. One unspawnable session therefore killed the
 *     whole daemon — every other live session with it.
 *
 * The second is the serious one: the blast radius of a bad session must be that
 * session.
 *
 * Written before the fix (directive 07). PRE-FIX both scenarios exit non-zero.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SM = resolve(import.meta.dirname, '../src/daemon/session-manager.ts');

/**
 * Run a scenario in a REAL child process.
 *
 * An unhandled 'error' event kills the process it happens in. Asserting on a
 * rejected promise inside this test would not notice that — only a separate
 * process can tell "threw an error" apart from "died".
 */
async function runScenario(
  code: string,
  env: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', code],
      { env: { ...process.env, ...env }, timeout: 60_000 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A GROK_HOME holding one persisted session whose cwd is gone. */
async function homeWithDeadCwd(): Promise<{ home: string; id: string; cwd: string }> {
  const home = await mkdtemp(join(tmpdir(), 'grokrc-spawnfail-'));
  const id = '019fd166-dead-7ca2-a756-a679728cd4d8';
  const cwd = join(home, 'a-directory-that-was-deleted');
  await mkdir(join(home, 'sessions', encodeURIComponent(cwd), id), { recursive: true });
  return { home, id, cwd };
}

test('resuming a session whose cwd is gone rejects, and the daemon survives', async () => {
  const { home, id, cwd } = await homeWithDeadCwd();
  try {
    const res = await runScenario(
      `
      const { SessionManager } = await import(${JSON.stringify(SM)});
      const sm = new SessionManager({});
      try {
        await sm.resume(${JSON.stringify(id)}, ${JSON.stringify(cwd)});
        console.log('UNEXPECTED: resume succeeded');
      } catch (err) {
        console.log('REJECTED: ' + err.message);
      }
      // If an unhandled 'error' event fired, we never reach this line.
      await new Promise((r) => setTimeout(r, 1500));
      console.log('SURVIVED');
      process.exit(0);
      `,
      { GROK_HOME: home, GROKRC_HOME: home }
    );

    assert.equal(
      res.code,
      0,
      `the daemon process died instead of reporting the failure.\nstderr:\n${res.stderr.slice(0, 900)}`
    );
    assert.match(res.stdout, /SURVIVED/, 'process exited before completing the scenario');
    assert.match(res.stdout, /REJECTED/, 'resume should reject, not resolve');
    assert.match(
      res.stdout,
      /working directory|does not exist|no longer exists/i,
      `the error should name the missing directory, not "spawn grok ENOENT". Got: ${res.stdout}`
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('creating a session in a directory that does not exist rejects, and the daemon survives', async () => {
  // The twin. create() and resume() have drifted apart on validation before.
  const home = await mkdtemp(join(tmpdir(), 'grokrc-spawnfail2-'));
  const cwd = join(home, 'never-created');
  try {
    const res = await runScenario(
      `
      const { SessionManager } = await import(${JSON.stringify(SM)});
      const sm = new SessionManager({});
      try {
        await sm.create(${JSON.stringify(cwd)});
        console.log('UNEXPECTED: create succeeded');
      } catch (err) {
        console.log('REJECTED: ' + err.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
      console.log('SURVIVED');
      process.exit(0);
      `,
      { GROK_HOME: home, GROKRC_HOME: home }
    );

    assert.equal(
      res.code,
      0,
      `the daemon process died instead of reporting the failure.\nstderr:\n${res.stderr.slice(0, 900)}`
    );
    assert.match(res.stdout, /SURVIVED/);
    assert.match(res.stdout, /REJECTED/);
    assert.match(res.stdout, /working directory|does not exist|no longer exists/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an unspawnable agent binary does not kill the daemon either', async () => {
  // The cwd guard cannot cover every spawn failure — a missing or unexecutable
  // `grok` still has to be survivable, or the same crash returns by another road.
  const home = await mkdtemp(join(tmpdir(), 'grokrc-spawnfail3-'));
  const cwd = join(home, 'work');
  try {
    await mkdir(cwd, { recursive: true });
    const res = await runScenario(
      `
      const { SessionManager } = await import(${JSON.stringify(SM)});
      const sm = new SessionManager({ grokCommand: 'grok-that-does-not-exist-anywhere' });
      try {
        await sm.create(${JSON.stringify(cwd)});
        console.log('UNEXPECTED: create succeeded');
      } catch (err) {
        console.log('REJECTED: ' + err.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
      console.log('SURVIVED');
      process.exit(0);
      `,
      { GROK_HOME: home, GROKRC_HOME: home }
    );

    assert.equal(
      res.code,
      0,
      `a missing agent binary killed the daemon.\nstderr:\n${res.stderr.slice(0, 900)}`
    );
    assert.match(res.stdout, /SURVIVED/);
    assert.match(res.stdout, /REJECTED/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
