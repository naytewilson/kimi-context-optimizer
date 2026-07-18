#!/usr/bin/env node

/**
 * KCO Doctor — install health check (Kimi Code port).
 *
 * Verifies plugin install integrity:
 *   - node >= 18
 *   - data dir writable (~/.kimi-context-optimizer/)
 *   - kimi.plugin.json exists, parses, and every hooks[].command that
 *     references src/*.js points at a file that exists on disk
 *   - ~/.kimi-code/config.toml parses (getActiveModel() returns a sane
 *     maxContextSize)
 *   - wire transcripts reachable: at least one wire.jsonl under
 *     ~/.kimi-code/sessions/ (warn if none — ground truth unavailable,
 *     estimation fallback active)
 *   - managed-copy check: Kimi runs the managed copy under
 *     ~/.kimi-code/plugins/managed/kimi-context-optimizer/, NOT the source
 *     dir — warn "reinstall to apply changes" when its version differs from
 *     the running source's version
 *
 * Fail-open: always exits 0. Prints [PASS]/[WARN]/[FAIL] lines + a summary.
 * Used by the /kco-doctor skill.
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  DATA_DIR, formatTokens, getPluginVersion, isMainModule
} from './utils.js';
import { getKimiHome, getActiveModel } from './kimi-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function runChecks() {
  const RESULTS = [];
  function check(name, fn) {
    try {
      const result = fn();
      if (result === true || result === undefined) {
        RESULTS.push({ name, status: 'PASS', detail: '' });
      } else if (typeof result === 'string') {
        RESULTS.push({ name, status: 'PASS', detail: result });
      } else if (result && result.warn) {
        RESULTS.push({ name, status: 'WARN', detail: result.warn });
      } else {
        RESULTS.push({ name, status: 'FAIL', detail: String(result) });
      }
    } catch (err) {
      RESULTS.push({ name, status: 'FAIL', detail: err.message });
    }
  }

  function readJSON(file) {
    return JSON.parse(readFileSync(file, 'utf-8'));
  }

  // ── Checks ────────────────────────────────────────────────────────────────

  check('node version', () => {
    const v = process.versions.node;
    const major = parseInt(v.split('.')[0], 10);
    if (major < 18) return `Node ${v} — plugin requires >=18`;
    return `Node ${v}`;
  });

  check('data directory writable', () => {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const probe = join(DATA_DIR, '.doctor-probe');
      writeFileSync(probe, 'ok');
      unlinkSync(probe);
      return DATA_DIR;
    } catch (e) {
      return `not writable: ${e.message}`;
    }
  });

  let manifest = null;
  check('plugin manifest (kimi.plugin.json)', () => {
    const f = join(ROOT, 'kimi.plugin.json');
    if (!existsSync(f)) return 'kimi.plugin.json not found at plugin root';
    try {
      manifest = readJSON(f);
    } catch (e) {
      return `kimi.plugin.json does not parse: ${e.message}`;
    }
    const hooks = Array.isArray(manifest.hooks) ? manifest.hooks.length : 0;
    return `v${manifest.version || '?'}, ${hooks} hooks wired`;
  });

  check('hook commands resolve to files', () => {
    if (!manifest || !Array.isArray(manifest.hooks)) {
      return { warn: 'no hooks array to check (see manifest check above)' };
    }
    const missing = [];
    let referenced = 0;
    for (const hook of manifest.hooks) {
      const cmd = hook && hook.command;
      if (typeof cmd !== 'string') continue;
      // Extract `node ./src/foo.js` (optionally with args) references.
      const m = cmd.match(/(?:^|\s)(?:node\s+)?(\.?\/?src\/[^\s"']+\.js)\b/);
      if (!m) continue; // non-script commands are out of scope
      referenced++;
      const rel = m[1].replace(/^\.?\//, '');
      if (!existsSync(join(ROOT, rel))) missing.push(rel);
    }
    if (missing.length > 0) {
      return `missing hook scripts: ${[...new Set(missing)].join(', ')}`;
    }
    return `${referenced} hook script reference(s) found on disk`;
  });

  check('Kimi CLI config (config.toml)', () => {
    const f = join(getKimiHome(), 'config.toml');
    if (!existsSync(f)) {
      return { warn: `${f} not found — using defaults (window ${formatTokens(getActiveModel().maxContextSize)})` };
    }
    const m = getActiveModel();
    if (!Number.isInteger(m.maxContextSize) || m.maxContextSize < 8192) {
      return `suspicious maxContextSize=${m.maxContextSize} — check config.toml`;
    }
    const name = m.displayName || m.model || m.alias || 'unknown model';
    return `model=${name}, window=${formatTokens(m.maxContextSize)}`;
  });

  check('wire transcripts reachable', () => {
    // Bounded walk of ~/.kimi-code/sessions/wd_*/<sid>/agents/*/wire.jsonl.
    const sessionsRoot = join(getKimiHome(), 'sessions');
    let found = 0;
    let visited = 0;
    const walk = (dir, depth) => {
      if (found > 0 || depth > 4 || visited > 500) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found > 0 || visited > 500) return;
        visited++;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name === 'wire.jsonl') found++;
      }
    };
    walk(sessionsRoot, 0);
    if (found === 0) {
      return { warn: 'no wire.jsonl found under sessions/ — ground truth unavailable, estimation fallback active' };
    }
    return `${found} wire transcript(s) reachable`;
  });

  check('managed plugin copy in sync', () => {
    const managed = join(getKimiHome(), 'plugins', 'managed', 'kimi-context-optimizer', 'kimi.plugin.json');
    if (!existsSync(managed)) {
      return `no managed copy installed (running from source at ${ROOT})`;
    }
    let managedVersion;
    try {
      managedVersion = readJSON(managed).version;
    } catch (e) {
      return { warn: `managed copy manifest unreadable: ${e.message}` };
    }
    const sourceVersion = getPluginVersion();
    if (managedVersion !== sourceVersion) {
      return { warn: `managed v${managedVersion} vs source v${sourceVersion} — Kimi runs the managed copy; reinstall to apply changes` };
    }
    return `managed copy in sync (v${managedVersion})`;
  });

  return RESULTS;
}

// ── Output ──────────────────────────────────────────────────────────────────

function main() {
  const RESULTS = runChecks();

  const symbols = { PASS: '✔', WARN: '⚠', FAIL: '✘' };
  const colors = process.stdout.isTTY ? {
    PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', reset: '\x1b[0m', dim: '\x1b[2m'
  } : { PASS: '', WARN: '', FAIL: '', reset: '', dim: '' };

  const failed = RESULTS.filter(r => r.status === 'FAIL').length;
  const warned = RESULTS.filter(r => r.status === 'WARN').length;
  const passed = RESULTS.filter(r => r.status === 'PASS').length;

  console.log('');
  console.log(`  KCO Doctor — v${getPluginVersion()}`);
  console.log('  ' + '─'.repeat(60));

  for (const r of RESULTS) {
    const c = colors[r.status];
    const sym = symbols[r.status];
    const detail = r.detail ? `${colors.dim} — ${r.detail}${colors.reset}` : '';
    console.log(`  ${c}${sym} [${r.status}]${colors.reset} ${r.name.padEnd(38)}${detail}`);
  }

  console.log('  ' + '─'.repeat(60));
  console.log(`  ${colors.PASS}${passed} pass${colors.reset}, ${colors.WARN}${warned} warn${colors.reset}, ${colors.FAIL}${failed} fail${colors.reset}`);
  if (failed > 0) {
    console.log('  Some checks failed — KCO hooks fail open, so sessions keep working, but the affected features are off.');
  }
  console.log('');

  // Fail-open: doctor always exits 0.
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch { process.exit(0); }
}
