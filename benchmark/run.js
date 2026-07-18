#!/usr/bin/env node

/**
 * KCO Benchmark Suite v1.0
 *
 * Reproducible scenarios that measure token savings from each KCO feature.
 * Ported from CCO (claude-context-optimizer); output is tokens-first —
 * dollar figures appear only when pricing is configured
 * (pricePerMillionInput/Output in ~/.kimi-context-optimizer/config.json).
 *
 * Usage: node benchmark/run.js
 */

import { estimateTokens, getPricing, computeCost, formatCost } from '../src/utils.js';
import { parseFileStructure, formatDigest } from '../src/file-digest.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ensureFixtures() {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  // 1. Large JS file (simulates reading a 500-line module)
  if (!existsSync(join(FIXTURES_DIR, 'large-module.js'))) {
    const lines = [];
    lines.push('import { something } from "./dep.js";');
    lines.push('');
    lines.push('export class DataProcessor {');
    lines.push('  constructor(config) {');
    lines.push('    this.config = config;');
    lines.push('    this.cache = new Map();');
    lines.push('  }');
    lines.push('');
    for (let i = 0; i < 30; i++) {
      lines.push(`  async process${i}(data) {`);
      for (let j = 0; j < 12; j++) {
        lines.push(`    const result${j} = await this.transform(data, ${j});`);
      }
      lines.push('    return data;');
      lines.push('  }');
      lines.push('');
    }
    lines.push('}');
    lines.push('');
    lines.push('export function helperFunction(x) {');
    lines.push('  return x * 2;');
    lines.push('}');
    writeFileSync(join(FIXTURES_DIR, 'large-module.js'), lines.join('\n'));
  }

  // 2. Large JSON config
  if (!existsSync(join(FIXTURES_DIR, 'config.json'))) {
    const config = {};
    for (let i = 0; i < 50; i++) {
      config[`section_${i}`] = {
        enabled: i % 2 === 0,
        timeout: 1000 + i * 100,
        retries: 3,
        endpoint: `https://api.example.com/v${i}`,
        options: { debug: false, verbose: true, maxConnections: 10 }
      };
    }
    writeFileSync(join(FIXTURES_DIR, 'config.json'), JSON.stringify(config, null, 2));
  }

  // 3. README.md
  if (!existsSync(join(FIXTURES_DIR, 'README.md'))) {
    const lines = ['# Project Title\n'];
    lines.push('## Installation\n');
    lines.push('```bash\nnpm install example\n```\n');
    lines.push('## Usage\n');
    for (let i = 0; i < 40; i++) {
      lines.push(`### Feature ${i}\n`);
      lines.push(`This feature does something useful. It integrates with the core module and provides functionality for case ${i}.\n`);
      lines.push(`\`\`\`js\nconst result = feature${i}();\nconsole.log(result);\n\`\`\`\n`);
    }
    lines.push('## License\n\nMIT\n');
    writeFileSync(join(FIXTURES_DIR, 'README.md'), lines.join('\n'));
  }

  // 4. package-lock.json (lockfile)
  if (!existsSync(join(FIXTURES_DIR, 'package-lock.json'))) {
    const lock = { name: 'example', version: '1.0.0', lockfileVersion: 3, packages: {} };
    for (let i = 0; i < 100; i++) {
      lock.packages[`node_modules/dep-${i}`] = {
        version: `${i}.0.0`,
        resolved: `https://registry.npmjs.org/dep-${i}/-/dep-${i}-${i}.0.0.tgz`,
        integrity: `sha512-${'a'.repeat(44)}=`,
        dependencies: { [`sub-dep-${i}`]: `^${i}.0.0` }
      };
    }
    writeFileSync(join(FIXTURES_DIR, 'package-lock.json'), JSON.stringify(lock, null, 2));
  }
}

// ── Benchmark scenarios ───────────────────────────────────────────────────────

function scenario_readCacheDedup(fixture, lineCount, ext) {
  const fullReadTokens = estimateTokens(lineCount, ext);
  // Second read: blocked by read-cache, returns digest instead
  const structure = parseFileStructure(fixture);
  const digest = formatDigest(structure, lineCount);
  const digestTokens = Math.round(digest.length / 3.7);

  return {
    name: 'Read Cache Dedup',
    description: 'Second read of same file → file digest instead of full content',
    withoutKCO: fullReadTokens * 2,   // two full reads
    withKCO: fullReadTokens + digestTokens,  // first read + digest
    unit: 'tokens'
  };
}

function scenario_readCacheMultiple(fixture, lineCount, ext, reads) {
  const fullReadTokens = estimateTokens(lineCount, ext);
  const structure = parseFileStructure(fixture);
  const digest = formatDigest(structure, lineCount);
  const digestTokens = Math.round(digest.length / 3.7);

  return {
    name: `Read Cache (${reads}x reads)`,
    description: `File read ${reads} times in a session`,
    withoutKCO: fullReadTokens * reads,
    withKCO: fullReadTokens + digestTokens * (reads - 1),
    unit: 'tokens'
  };
}

function scenario_contextignoreBlock(fixture, lineCount, ext) {
  const fullReadTokens = estimateTokens(lineCount, ext);
  return {
    name: 'Contextignore Block',
    description: 'Lockfile/generated file blocked entirely by .contextignore',
    withoutKCO: fullReadTokens,
    withKCO: 0,
    unit: 'tokens'
  };
}

function scenario_fileDigestVsFull(fixture, ext) {
  const content = readFileSync(fixture, 'utf-8');
  const lineCount = content.split('\n').length;
  const fullTokens = estimateTokens(lineCount, ext);
  const structure = parseFileStructure(fixture);
  const digest = formatDigest(structure, lineCount);
  const digestTokens = Math.round(digest.length / 3.7);

  return {
    name: 'File Digest vs Full Read',
    description: 'Navigational digest (~landmarks) vs full file content',
    withoutKCO: fullTokens,
    withKCO: digestTokens,
    unit: 'tokens'
  };
}

function scenario_typicalSession() {
  // Simulate a realistic 45-min coding session
  const files = [
    { name: 'main.js', lines: 300, ext: '.js', reads: 3, edits: 2 },
    { name: 'utils.js', lines: 200, ext: '.js', reads: 2, edits: 1 },
    { name: 'config.json', lines: 150, ext: '.json', reads: 2, edits: 0 },
    { name: 'README.md', lines: 250, ext: '.md', reads: 1, edits: 0 },
    { name: 'test.js', lines: 400, ext: '.js', reads: 2, edits: 1 },
    { name: 'package.json', lines: 30, ext: '.json', reads: 1, edits: 0 },
    { name: 'types.ts', lines: 180, ext: '.ts', reads: 1, edits: 0 },
    { name: 'api.js', lines: 350, ext: '.js', reads: 2, edits: 1 },
    { name: 'styles.css', lines: 100, ext: '.css', reads: 1, edits: 0 },
    { name: 'helpers.js', lines: 120, ext: '.js', reads: 1, edits: 0 },
  ];

  let withoutKCO = 0;
  let withKCO = 0;

  for (const f of files) {
    const tokensPerRead = estimateTokens(f.lines, f.ext);
    const digestTokens = Math.round(tokensPerRead * 0.05); // ~5% of full read

    // Without KCO: every read is a full read
    withoutKCO += tokensPerRead * f.reads;

    // With KCO: first read is full, subsequent reads are digests
    withKCO += tokensPerRead; // first read always
    if (f.reads > 1) {
      withKCO += digestTokens * (f.reads - 1); // subsequent = digest
    }
  }

  return {
    name: 'Typical Session (10 files, 45 min)',
    description: 'Realistic coding session with mixed reads/edits across 10 files',
    withoutKCO,
    withKCO,
    unit: 'tokens'
  };
}

// ── Cache-economics scenario ─────────────────────────────────────────────────
// Kimi's wire transcript reports real inputCacheRead / inputCacheCreation per
// step. A redundant re-read is not just context bloat — those tokens leave the
// cached-read bucket and are re-billed as fresh input. Token-first; dollars
// only when the user configured pricing.

function scenario_cacheEconomics(contextTokens, rereadsPerDay) {
  return {
    name: `Redundant re-reads avoided (${Math.round(contextTokens / 1000)}K ctx)`,
    description: `${rereadsPerDay} blocked re-reads/day keep ${Math.round(contextTokens / 1000)}K tokens in the cheap inputCacheRead bucket`,
    tokensPerDay: contextTokens * rereadsPerDay,
    rereadsPerDay,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

function runBenchmarks() {
  ensureFixtures();

  const jsFile = join(FIXTURES_DIR, 'large-module.js');
  const jsonFile = join(FIXTURES_DIR, 'config.json');
  const mdFile = join(FIXTURES_DIR, 'README.md');
  const lockFile = join(FIXTURES_DIR, 'package-lock.json');

  const jsLines = readFileSync(jsFile, 'utf-8').split('\n').length;
  const jsonLines = readFileSync(jsonFile, 'utf-8').split('\n').length;
  const mdLines = readFileSync(mdFile, 'utf-8').split('\n').length;
  const lockLines = readFileSync(lockFile, 'utf-8').split('\n').length;

  const scenarios = [
    scenario_readCacheDedup(jsFile, jsLines, '.js'),
    scenario_readCacheMultiple(jsFile, jsLines, '.js', 5),
    scenario_fileDigestVsFull(jsFile, '.js'),
    scenario_readCacheDedup(jsonFile, jsonLines, '.json'),
    scenario_contextignoreBlock(lockFile, lockLines, '.json'),
    scenario_fileDigestVsFull(mdFile, '.md'),
    scenario_typicalSession(),
  ];

  // Output
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════════════╗');
  console.log('  ║             KCO Benchmark Suite — Token Savings Proof            ║');
  console.log('  ╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Scenario                            Without KCO   With KCO   Savings');
  console.log('  ──────────────────────────────────   ───────────   ────────   ───────');

  let totalWithout = 0;
  let totalWith = 0;

  for (const s of scenarios) {
    const savings = s.withoutKCO - s.withKCO;
    const pct = s.withoutKCO > 0 ? Math.round((savings / s.withoutKCO) * 100) : 0;
    totalWithout += s.withoutKCO;
    totalWith += s.withKCO;

    const name = s.name.padEnd(36);
    const without = String(s.withoutKCO).padStart(11);
    const withK = String(s.withKCO).padStart(8);
    const savStr = `${pct}%`.padStart(5);
    console.log(`  ${name}   ${without}   ${withK}   ${savStr}`);
  }

  const totalSavings = totalWithout - totalWith;
  const totalPct = totalWithout > 0 ? Math.round((totalSavings / totalWithout) * 100) : 0;

  console.log('  ──────────────────────────────────   ───────────   ────────   ───────');
  console.log(`  ${'TOTAL'.padEnd(36)}   ${String(totalWithout).padStart(11)}   ${String(totalWith).padStart(8)}   ${(totalPct + '%').padStart(5)}`);
  console.log('');
  console.log(`  Overall: ${totalPct}% fewer tokens with KCO enabled`);
  console.log(`  That's ${totalSavings.toLocaleString()} tokens saved across all scenarios`);
  console.log('');

  // ── Cache economics (real inputCacheRead/inputCacheCreation buckets) ──
  const pricing = getPricing();
  const cacheScenarios = [
    scenario_cacheEconomics(150_000, 3),
    scenario_cacheEconomics(400_000, 3),
  ];
  console.log('  Cache economics — tokens kept in the cheap cached-read bucket per day:');
  for (const b of cacheScenarios) {
    let line = `    ${b.name.padEnd(40)} ${b.tokensPerDay.toLocaleString()} tokens/day`;
    if (pricing) {
      const perDay = computeCost(b.tokensPerDay, 'input');
      if (perDay != null) line += `  ≈ ${formatCost(perDay * 22)}/month at your configured price`;
    }
    console.log(line);
  }
  if (!pricing) {
    console.log('    (set pricePerMillionInput/Output in ~/.kimi-context-optimizer/config.json for $ figures)');
  }
  console.log('');

  // JSON output for CI/landing page
  const results = {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    totalSavingsPercent: totalPct,
    totalTokensWithout: totalWithout,
    totalTokensWith: totalWith,
    scenarios: scenarios.map(s => ({
      name: s.name,
      description: s.description,
      withoutKCO: s.withoutKCO,
      withKCO: s.withKCO,
      savingsPercent: s.withoutKCO > 0 ? Math.round(((s.withoutKCO - s.withKCO) / s.withoutKCO) * 100) : 0
    })),
    cacheEconomics: cacheScenarios.map(b => ({
      name: b.name,
      description: b.description,
      tokensPerDay: b.tokensPerDay,
      rereadsPerDay: b.rereadsPerDay,
    })),
  };

  const resultsFile = join(__dirname, 'results.json');
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`  Results saved to benchmark/results.json`);
  console.log('');
}

runBenchmarks();
