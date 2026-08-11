/**
 * Claims in the docs must not outlive the thing they describe.
 *
 * BACKLOG #12. Two kinds of rot were shipped and neither had a detector:
 *
 *  1. A COUNT. FAQ.md said "153 tests" and README said "204 tests" while the
 *     suite had moved on. Nobody edits a number they are not looking at, so the
 *     rule is that prose does not carry one — `npm test` is the source of truth
 *     and it is one command away.
 *
 *  2. AN UNTESTED CLAIM PRESENTED AS FACT. FAQ.md said Android push "is
 *     straightforward there", while tools/backlog.mjs recorded item #8 as open
 *     with evidence "UNKNOWN — no Android device available". The repo contained
 *     both the claim and the record contradicting it.
 *
 * The second check reads the BACKLOG DATA, not a copy of it: while #8 is open,
 * the docs have to say Android push is untested. When someone finally tests it
 * and closes #8, this check stops demanding the caveat — so it cannot become a
 * stale rule of its own.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFile(join(ROOT, p), 'utf8');

/** Prose docs, excluding generated ones. docs/BACKLOG.md is generated from
 *  tools/backlog.mjs and its entries are dated records of a specific run, so a
 *  count inside one is history rather than a live claim. */
const PROSE = ['README.md', 'docs/FAQ.md', 'docs/USER-GUIDE.md', 'SETUP.md', 'CONTRIBUTING.md'];

test('no doc hardcodes a test count', async () => {
  const offenders: string[] = [];
  for (const f of PROSE) {
    const src = await read(f).catch(() => '');
    for (const line of src.split('\n')) {
      // "204 tests", "153 tests —", but not "the tests" or "npm test".
      if (/\b\d{2,}\s+tests\b/i.test(line)) offenders.push(`${f}: ${line.trim()}`);
      // Shields badges URL-encode the space, so `tests-204%20passing` slipped
      // past the prose pattern above and sat in the README for weeks.
      else if (/badge\/tests?-\d+/i.test(line)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a hardcoded test count rots the moment a test is added:\n  ${offenders.join('\n  ')}`
  );
});

test('while Android push is untested, the docs say so', async () => {
  const { ITEMS } = await import('../tools/backlog.mjs');
  const android = (ITEMS as { id: number; status: string }[]).find((i) => i.id === 8);
  assert.ok(android, 'backlog #8 (Android push) must exist for this check to mean anything');

  if (android.status !== 'open') return; // tested and closed — the caveat is no longer required

  for (const f of ['docs/FAQ.md', 'docs/USER-GUIDE.md']) {
    // Normalise before matching: the sentence is wrapped across lines, sits
    // inside a blockquote in one file, and carries markdown bold in both. My
    // first version matched a raw substring and failed on the very docs it was
    // written for — the detector was wrong, not the docs.
    const src = (await read(f))
      .replace(/\*\*/g, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\s+/g, ' ');
    assert.match(
      src,
      /not been tested on a physical Android device/i,
      `${f} must state that Android push is untested while backlog #8 is open`
    );
  }
});

test('no doc claims Android push is verified while #8 is open', async () => {
  const { ITEMS } = await import('../tools/backlog.mjs');
  const android = (ITEMS as { id: number; status: string }[]).find((i) => i.id === 8);
  if (android?.status !== 'open') return;

  // The exact sentence that shipped: "push is straightforward there".
  const banned = /push is straightforward/i;
  for (const f of ['docs/FAQ.md', 'docs/USER-GUIDE.md', 'README.md']) {
    const src = await read(f).catch(() => '');
    assert.ok(!banned.test(src), `${f} asserts Android push works, but #8 records it as untested`);
  }
});

test('every internal doc link points at a heading that exists', async () => {
  // Written because I shipped a dead one in this very commit: a link to
  // #why-the-notification-row-says-push-is-unavailable, a heading that never
  // existed. Prose links are never exercised by anything, so nothing noticed.
  const { readdir } = await import('node:fs/promises');
  const files = [
    'README.md',
    ...(await readdir(join(ROOT, 'docs'))).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  ];

  /** GitHub's slug: lowercase, drop anything but word chars/space/hyphen, spaces to hyphens. */
  const slug = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\w\s-]/g, '')
      // ONE hyphen per space, not per RUN of spaces. Removing an em-dash leaves
      // two spaces behind and GitHub emits two hyphens — collapsing them here
      // reported three live anchors as dead. Same slug bug bit this repo once
      // before, in the README table of contents.
      .replace(/ /g, '-');

  const headings = new Map<string, Set<string>>();
  const sources = new Map<string, string>();
  for (const f of files) {
    const src = await read(f);
    sources.set(f, src);
    const set = new Set<string>();
    for (const m of src.matchAll(/^#{1,6}\s+(.+)$/gm)) set.add(slug(m[1]!));
    headings.set(f, set);
  }

  const broken: string[] = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = m[1]!;
      if (/^[a-z]+:/i.test(href)) continue; // external
      const [path, anchor] = href.split('#');
      if (!anchor) continue; // file-only links are covered by the repo layout
      // Resolve the target file relative to the linking file's directory.
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      const target = !path ? f : join(dir, path).replace(/^\.\//, '');
      const set = headings.get(target);
      if (!set) continue; // link into a file this sweep does not cover
      if (!set.has(anchor)) broken.push(`${f} -> ${href}`);
    }
  }

  assert.deepEqual(broken, [], `dead anchors:\n  ${broken.join('\n  ')}`);
});

test('no doc asserts a platform works without having measured it', async () => {
  // Backlog #6 was closed with the result "README no longer says 'expected to
  // work'". README line 136 still said exactly that, months later — the record
  // asserted a doc edit that had not happened, and nothing re-read the file.
  //
  // These are the phrases directive 08 bans as a basis for a REPORT, not just
  // for action. A platform either has a CI job or it does not.
  const banned = /\b(expected to work|should work|probably works|ought to work)\b/i;
  const offenders: string[] = [];
  for (const f of PROSE) {
    const src = await read(f).catch(() => '');
    src.split('\n').forEach((line, i) => {
      if (banned.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `state what CI measures, or say it is untested:\n  ${offenders.join('\n  ')}`
  );
});

test('user-facing docs carry no internal tracker references', async () => {
  // docs/BACKLOG.md is the internal record and is excluded from PROSE. A reader
  // of the README or SECURITY.md has no way to look up "backlog #16", so the
  // reference is noise at best and an unanswered question at worst.
  const banned = /\bbacklog #\d+/i;
  const offenders: string[] = [];
  for (const f of PROSE) {
    const src = await read(f).catch(() => '');
    src.split('\n').forEach((line, i) => {
      if (banned.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `state the limitation directly instead of citing an internal item:\n  ${offenders.join('\n  ')}`
  );
});
