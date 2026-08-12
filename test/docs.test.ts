/**
 * User docs must stay accurate and linked.
 *
 * - No hardcoded test counts (they rot).
 * - While Android push is untested (backlog item 8), docs must say so.
 * - Internal markdown links must resolve to real headings.
 * - No “expected to work” platform claims without CI.
 * - No “backlog #N” in user-facing prose.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFile(join(ROOT, p), 'utf8');

/** User-facing prose (not generated BACKLOG, not internal notes). */
const PROSE = ['README.md', 'docs/GUIDE.md', 'docs/ARCHITECTURE.md', 'CONTRIBUTING.md'];

test('no doc hardcodes a test count', async () => {
  const offenders: string[] = [];
  for (const f of PROSE) {
    const src = await read(f).catch(() => '');
    for (const line of src.split('\n')) {
      if (/\b\d{2,}\s+tests\b/i.test(line)) offenders.push(`${f}: ${line.trim()}`);
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
  assert.ok(android, 'backlog item 8 (Android push) must exist for this check');

  if (android.status !== 'open') return;

  const src = (await read('docs/GUIDE.md'))
    .replace(/\*\*/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ');
  assert.match(
    src,
    /not (yet )?tested on a physical Android device|not validated on a physical Android device/i,
    'docs/GUIDE.md must state that Android push is untested while backlog item 8 is open'
  );
});

test('no doc claims Android push is verified while item 8 is open', async () => {
  const { ITEMS } = await import('../tools/backlog.mjs');
  const android = (ITEMS as { id: number; status: string }[]).find((i) => i.id === 8);
  if (android?.status !== 'open') return;

  const banned = /push is straightforward/i;
  for (const f of ['docs/GUIDE.md', 'README.md']) {
    const src = await read(f).catch(() => '');
    assert.ok(!banned.test(src), `${f} asserts Android push works, but item 8 records it as untested`);
  }
});

test('every internal doc link points at a heading that exists', async () => {
  const files = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    ...(await readdir(join(ROOT, 'docs')))
      .filter((f) => f.endsWith('.md') && !['BACKLOG.md'].includes(f))
      .map((f) => `docs/${f}`),
  ];

  const slug = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/ /g, '-');

  const headings = new Map<string, Set<string>>();
  const sources = new Map<string, string>();
  for (const f of files) {
    const src = await read(f).catch(() => '');
    if (!src) continue;
    sources.set(f, src);
    const set = new Set<string>();
    for (const m of src.matchAll(/^#{1,6}\s+(.+)$/gm)) set.add(slug(m[1]!));
    headings.set(f, set);
  }

  const broken: string[] = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = m[1]!;
      if (/^[a-z]+:/i.test(href)) continue;
      const [path, anchor] = href.split('#');
      if (!anchor) continue;
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      const target = !path ? f : join(dir, path).replace(/^\.\//, '');
      const set = headings.get(target);
      if (!set) continue;
      if (!set.has(anchor)) broken.push(`${f} -> ${href}`);
    }
  }

  assert.deepEqual(broken, [], `dead anchors:\n  ${broken.join('\n  ')}`);
});

test('no doc asserts a platform works without having measured it', async () => {
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
