#!/usr/bin/env node

/**
 * KCO Doctor — install and live-contract health check.
 *
 * Besides installation integrity, doctor verifies that reachable wire
 * transcripts contain a usage schema KCO actually understands. A file named
 * wire.jsonl is not sufficient evidence if Kimi changed its usage records.
 * Fail-open: doctor always exits 0 and reports PASS/WARN/FAIL diagnostics.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  DATA_DIR, formatTokens, getPluginVersion, isMainModule
} from './utils.js';
import { getKimiHome, getActiveModel } from './kimi-config.js';
import { parseWireText } from './wire-usage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Classify one or more wire transcripts by schemas recognized by KCO's real
 * parser. Exported so fixtures can prove that unknown future usage rows do not
 * masquerade as ground truth.
 */
export function classifyWireContracts(wirePaths = []) {
  const schemas = new Set();
  let recognizedUsageRows = 0;
  let readableFiles = 0;

  for (const path of wirePaths || []) {
    try {
      const parsed = parseWireText(readFileSync(path, 'utf8'));
      readableFiles++;
      recognizedUsageRows += parsed.recognizedUsageRows || 0;
      for (const schema of parsed.wireSchemas || []) schemas.add(schema);
    } catch { /* unreadable file is not proof of a supported contract */ }
  }

  return {
    status: readableFiles === 0 ? 'missing' : (recognizedUsageRows > 0 ? 'supported' : 'unsupported'),
    readableFiles,
    recognizedUsageRows,
    wireSchemas: [...schemas].sort(),
  };
}

function findWireTranscripts(limit = 3) {
  const sessionsRoot = join(getKimiHome(), 'sessions');
  const paths = [];
  let visited = 0;

  const walk = (dir, depth) => {
    if (paths.length >= limit || depth > 4 || visited > 500) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (paths.length >= limit || visited > 500) break;
      visited++;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'wire.jsonl') paths.push(full);
    }
  };

  walk(sessionsRoot, 0);
  return paths;
}

function runChecks() {
  const RESULTS = [];
  function check(name, fn) {
    try {
      const result = fn();
      if (result === true || result === undefined) RESULTS.push({ name, status: 'PASS', detail: '' });
      else if (typeof result === 'string') RESULTS.push({ name, status: 'PASS', detail: result });
      else if (result && result.warn) RESULTS.push({ name, status: 'WARN', detail: result.warn });
      else RESULTS.push({ name, status: 'FAIL', detail: String(result) });
    } catch (err) {
      RESULTS.push({ name, status: 'FAIL', detail: err.message });
    }
  }

  function readJSON(file) {
    return JSON.parse(readFileSync(file, 'utf-8'));
  }

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
    try { manifest = readJSON(f); }
    catch (e) { return `kimi.plugin.json does not parse: ${e.message}`; }
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
      const m = cmd.match(/(?:^|\s)(?:node\s+)?(\.?\/?src\/[^\s"']+\.js)\b/);
      if (!m) continue;
      referenced++;
      const rel = m[1].replace(/^\.?\//, '');
      if (!existsSync(join(ROOT, rel))) missing.push(rel);
    }
    if (missing.length > 0) return `missing hook scripts: ${[...new Set(missing)].join(', ')}`;
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
    const paths = findWireTranscripts(3);
    if (paths.length === 0) {
      return { warn: 'no wire.jsonl found under sessions/ — ground truth unavailable, estimation fallback active' };
    }
    const contract = classifyWireContracts(paths);
    if (contract.status !== 'supported') {
      return {
        warn:
          `${paths.length} wire transcript(s) reachable but 0 supported usage rows found — ` +
          `possible Kimi schema drift; ground-truth accounting disabled until updated`,
      };
    }
    return (
      `${paths.length} wire transcript(s) reachable; ${contract.recognizedUsageRows} usage row(s); ` +
      `schema=${contract.wireSchemas.join(',')}`
    );
  });

  check('managed plugin copy in sync', () => {
    const managed = join(getKimiHome(), 'plugins', 'managed', 'kimi-context-optimizer', 'kimi.plugin.json');
    if (!existsSync(managed)) return `no managed copy installed (running from source at ${ROOT})`;
    let managedVersion;
    try { managedVersion = readJSON(managed).version; }
    catch (e) { return { warn: `managed copy manifest unreadable: ${e.message}` }; }
    const sourceVersion = getPluginVersion();
    if (managedVersion !== sourceVersion) {
      return { warn: `managed v${managedVersion} vs source v${sourceVersion} — Kimi runs the managed copy; reinstall to apply changes` };
    }
    return `managed copy in sync (v${managedVersion})`;
  });

  return RESULTS;
}

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
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch { process.exit(0); }
}
