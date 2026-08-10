#!/usr/bin/env node
/**
 * Render and check the backlog. ONE implementation over tools/backlog.mjs.
 *
 *   node tools/backlog-report.mjs            progress, X of N
 *   node tools/backlog-report.mjs --write    regenerate docs/BACKLOG.md
 *   node tools/backlog-report.mjs --check    exit 1 if the doc has drifted
 *
 * Why a generator rather than editing the document: a sweep is only honest if
 * the total is fixed before it starts and every item is accounted for at the
 * end. Prose lets an item quietly change status in one place and not another —
 * that is how "processed X of N" becomes a claim instead of a count.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEMS, SECTIONS } from './backlog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = resolve(ROOT, 'docs/BACKLOG.md');

const CLOSED = new Set(['done', 'accepted', 'not-a-limitation']);
const esc = (s) => String(s).replace(/\|/g, '\\|');

export function render() {
  const N = ITEMS.length;
  const closed = ITEMS.filter((i) => CLOSED.has(i.status));
  const open = ITEMS.filter((i) => !CLOSED.has(i.status));

  const out = [];
  out.push('# grokrc — open items\n');
  out.push(
    `**${closed.length} of ${N} closed.** Generated from \`tools/backlog.mjs\` —`,
    'edit that, then run `npm run backlog -- --write`. `npm run backlog -- --check`',
    'fails if this file has drifted, so status cannot be claimed in one place and',
    'contradicted in another.\n'
  );
  out.push('Evidence classes: **VERIFIED** (observed, with what showed it) ·');
  out.push('**UNVERIFIED** (believed, with the check that settles it) · **UNKNOWN**.\n');
  out.push('Status: `open` · `done` · `accepted` (no action intended) · `not-a-limitation`.\n');
  out.push('---\n');

  for (const [key, name] of Object.entries(SECTIONS)) {
    const rows = ITEMS.filter((i) => i.section === key);
    if (!rows.length) continue;
    const c = rows.filter((i) => CLOSED.has(i.status)).length;
    out.push(`## ${key} · ${name}  —  ${c}/${rows.length} closed\n`);
    out.push('| # | Item | Status | Evidence |');
    out.push('| --- | --- | --- | --- |');
    for (const i of rows) {
      out.push(`| ${i.id} | ${esc(i.title)} | \`${i.status}\` | ${esc(i.evidence)} |`);
    }
    out.push('');
    for (const i of rows) {
      if (!i.loop && !i.result) continue;
      out.push(`### ${i.id} · ${i.title}\n`);
      if (i.loop?.analyse) out.push(`**Analyse.** ${i.loop.analyse}\n`);
      if (i.loop?.evaluate) out.push(`**Evaluate.** ${i.loop.evaluate}\n`);
      if (i.loop?.attacked) out.push(`**Reanalyse — attacked.** ${i.loop.attacked}\n`);
      if (i.loop?.survived) out.push(`**Reevaluate — survived.** ${i.loop.survived}\n`);
      if (i.loop?.decide) out.push(`**Decide.** ${i.loop.decide}\n`);
      if (i.result) out.push(`**Result.** ${i.result}\n`);
    }
  }

  if (open.length) {
    out.push('---\n');
    out.push(`## Still open — ${open.length}\n`);
    for (const i of open) out.push(`- **#${i.id}** ${i.title}`);
    out.push('');
  }
  return out.join('\n');
}

/** Anything claiming to be done must carry the artifact that proves it. */
function auditIntegrity() {
  const problems = [];
  const seen = new Set();
  for (const i of ITEMS) {
    if (seen.has(i.id)) problems.push(`#${i.id}: duplicate id`);
    seen.add(i.id);
    if (!SECTIONS[i.section]) problems.push(`#${i.id}: unknown section ${i.section}`);
    if (i.status === 'done') {
      if (!i.loop?.attacked) problems.push(`#${i.id}: marked done with no REANALYSE artifact`);
      if (!i.result) problems.push(`#${i.id}: marked done with no result`);
    }
  }
  return problems;
}

const args = process.argv.slice(2);
const body = render();

if (args.includes('--write')) {
  await writeFile(DOC, body);
  console.log(`  wrote docs/BACKLOG.md (${ITEMS.length} items)`);
}

const problems = auditIntegrity();
if (problems.length) {
  console.error('\n  BACKLOG INTEGRITY:');
  for (const p of problems) console.error(`    ✗ ${p}`);
}

if (args.includes('--check')) {
  const onDisk = await readFile(DOC, 'utf8').catch(() => '');
  if (onDisk !== body) {
    console.error('  ✗ docs/BACKLOG.md is out of date — run: npm run backlog -- --write');
    process.exit(1);
  }
  if (problems.length) process.exit(1);
  console.log('  ✓ backlog document matches the data, and every closed item carries its artifact');
}

if (!args.includes('--write') && !args.includes('--check')) {
  const closed = ITEMS.filter((i) => CLOSED.has(i.status));
  console.log(`\n  processed ${closed.length} of ${ITEMS.length}\n`);
  for (const i of ITEMS) {
    const mark = CLOSED.has(i.status) ? '✓' : '·';
    console.log(
      `  ${mark} #${String(i.id).padStart(2)}  ${i.status.padEnd(18)} ${i.title.slice(0, 78)}`
    );
  }
  console.log('');
  if (problems.length) process.exit(1);
}
