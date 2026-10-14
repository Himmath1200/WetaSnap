// Summarises e2e/.results/results.json and docs/testing/findings/*.json into Markdown for the test report.
// Usage: node e2e/summarize.mjs [results.json ...]  (later files override earlier outcomes = re-runs)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : [resolve(here, '.results/results.json')];
const outcome = new Map(); // title -> { file, status, error, runs: [] }

function walk(suite, file, prefix = []) {
  for (const s of suite.suites ?? []) walk(s, s.file ?? file, s.title && !s.title.endsWith('.ts') ? [...prefix, s.title] : prefix);
  for (const sp of suite.specs ?? []) {
    for (const t of sp.tests ?? []) {
      const key = `${sp.file ?? file} › ${[...prefix, sp.title].join(' › ')}`;
      const last = t.results.at(-1);
      const cur = outcome.get(key) ?? { file: sp.file ?? file, title: [...prefix, sp.title].join(' › '), runs: [] };
      for (const r of t.results) cur.runs.push(r.status);
      cur.status = last?.status ?? 'skipped';
      cur.error = (last?.errors?.[0]?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? '';
      outcome.set(key, cur);
    }
  }
}
for (const f of files) { const j = JSON.parse(readFileSync(f, 'utf8')); for (const s of j.suites) walk(s, s.file); }

const rows = [...outcome.values()];
const passed = rows.filter((r) => r.status === 'passed');
const failed = rows.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
const flaky = rows.filter((r) => r.status === 'passed' && r.runs.some((x) => x !== 'passed'));
console.log(`TOTAL ${rows.length} PASSED ${passed.length} FAILED ${failed.length} FLAKY ${flaky.length}`);
console.log('\n## FAILED');
for (const r of failed) console.log(`- [${r.file}] ${r.title} :: ${r.error.slice(0, 220)}`);
console.log('\n## FLAKY (passed on re-run)');
for (const r of flaky) console.log(`- [${r.file}] ${r.title} runs=${r.runs.join(',')}`);
console.log('\n## ALL');
for (const r of rows) console.log(`${r.status}\t${r.file}\t${r.title}`);

const fdir = resolve(here, '../../../docs/testing/findings');
if (existsSync(fdir)) {
  console.log('\n## VISUAL');
  const agg = { overflow: [], nav: [], small: new Map(), contrast: new Map(), console: [], errors: [], other: new Map() };
  for (const name of readdirSync(fdir).filter((n) => n.startsWith('visual-'))) {
    const combo = name.replace(/^visual-|\.json$/g, '');
    for (const f of JSON.parse(readFileSync(resolve(fdir, name), 'utf8'))) {
      const where = `${combo} ${f.screen}`;
      if (f.error) agg.errors.push(`${where}: ${f.error}`);
      if (f.overflow) agg.overflow.push(`${where}: scrollWidth ${f.overflow.scrollWidth} > ${f.overflow.innerWidth} (${f.overflow.culprits.join(', ')})`);
      if (f.navOverlap.length) agg.nav.push(`${where}: ${f.navOverlap.join(', ')}`);
      for (const s of f.smallTargets) { const k = s.el.replace(/"[^"]*\d[^"]*"/, '"…"'); const v = agg.small.get(k) ?? { n: 0, size: `${s.w}×${s.h}`, where: new Set() }; v.n++; v.where.add(combo.split('-').slice(0, -2).join('-') + ' ' + f.screen); agg.small.set(k, v); }
      for (const c of f.contrast) { const k = `${c.html.slice(0, 80)} | ${c.fg} on ${c.bg} = ${c.ratio}:1 (needs ${c.expected})`; const v = agg.contrast.get(k) ?? new Set(); v.add(where); agg.contrast.set(k, v); }
      for (const e of f.consoleErrors) agg.console.push(`${where}: ${e.slice(0, 200)}`);
      for (const o of f.otherA11y) { const k = `${o.id} (${o.impact}): ${o.help}`; const v = agg.other.get(k) ?? new Set(); v.add(where); agg.other.set(k, v); }
    }
  }
  console.log('\n### errors opening screens'); agg.errors.forEach((x) => console.log('- ' + x));
  console.log('\n### overflow'); agg.overflow.forEach((x) => console.log('- ' + x));
  console.log('\n### bottom-nav overlap'); agg.nav.forEach((x) => console.log('- ' + x));
  console.log('\n### console errors'); agg.console.forEach((x) => console.log('- ' + x));
  console.log('\n### small targets (element · typical size · count · screens)');
  [...agg.small].sort((a, b) => b[1].n - a[1].n).slice(0, 60).forEach(([k, v]) => console.log(`- ${k} · ${v.size} · ${v.n} · ${[...v.where].slice(0, 4).join('; ')}`));
  console.log('\n### contrast');
  [...agg.contrast].sort((a, b) => b[1].size - a[1].size).slice(0, 60).forEach(([k, v]) => console.log(`- ${k} · ${v.size} screens · e.g. ${[...v].slice(0, 3).join('; ')}`));
  console.log('\n### other axe (1366 light)');
  [...agg.other].forEach(([k, v]) => console.log(`- ${k} · ${[...v].slice(0, 5).join('; ')}`));
}
