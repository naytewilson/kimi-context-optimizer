#!/usr/bin/env node

/**
 * ContextShield v1.1 — advisory historical-read guard for Kimi Code.
 *
 * Supports both current ReadFile and legacy Read payloads through the shared
 * hook normalizer. Historical token figures are explicitly estimates of prior
 * read volume; they are not promoted to proven KCO savings.
 */

import { basename, join, relative } from 'path';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import {
  PATTERNS_FILE,
  formatTokens, loadJSON, ensureDataDirs
} from './utils.js';
import {
  isMainModule, runHook, resolvePayloadPath, normalizeHookPayload,
} from './hook-io.js';
import { emitNotice } from './notices.js';

ensureDataDirs();

function loadPatterns() {
  return loadJSON(PATTERNS_FILE) || { projects: {}, taskPatterns: {}, lastUpdated: null };
}

function getProjectPatterns(patterns, projectRoot) {
  const key = projectRoot || '_global';
  return patterns.projects[key] || { fileFrequency: {}, wastedReads: {}, coOccurrence: {} };
}

function findProjectForPath(patterns, filePath) {
  for (const key of Object.keys(patterns.projects || {})) {
    if (key !== '_global' && filePath.startsWith(key)) return key;
  }
  return null;
}

export function buildIgnoreSuggestions(patterns, projectRoot, existingIgnore = [], minSessions = 3) {
  const existing = new Set(existingIgnore.map(l => l.trim()).filter(Boolean));
  const out = [];
  for (const [projKey, proj] of Object.entries(patterns.projects || {})) {
    if (projKey !== '_global' && projKey !== projectRoot) continue;
    for (const [filePath, d] of Object.entries(proj.wastedReads || {})) {
      if ((d.sessions || 0) < minSessions) continue;
      if (!filePath.startsWith(projectRoot + '/')) continue;
      const pattern = relative(projectRoot, filePath);
      if (!pattern || pattern.startsWith('..') || existing.has(pattern)) continue;
      out.push({ pattern, sessions: d.sessions, tokens: d.totalTokensWasted || 0 });
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens).slice(0, 20);
}

function readIgnoreLines(cwd) {
  const file = join(cwd, '.contextignore');
  if (!existsSync(file)) return [];
  try { return readFileSync(file, 'utf-8').split('\n'); } catch { return []; }
}

function suggestOrApply(mode) {
  const cwd = process.cwd();
  const patterns = loadPatterns();
  const suggestions = buildIgnoreSuggestions(patterns, cwd, readIgnoreLines(cwd));

  if (!suggestions.length) {
    console.log('\n  No .contextignore candidates yet — nothing was unused in 3+ sessions');
    console.log('  (or the recurring-read files are already ignored).\n');
    return;
  }

  const total = suggestions.reduce((s, x) => s + x.tokens, 0);
  console.log(
    `\n  .CONTEXTIGNORE ${mode === 'apply' ? 'APPLIED' : 'SUGGESTIONS'} — ` +
    `${suggestions.length} file(s), ~${formatTokens(total)} estimated historical read volume/session`
  );
  console.log('  ' + '─'.repeat(60));
  for (const s of suggestions) {
    console.log(
      `  ${s.pattern.padEnd(44)} unused in ${s.sessions} sessions ` +
      `(~${formatTokens(s.tokens)} estimated historical read volume)`
    );
  }

  if (mode === 'apply') {
    const file = join(cwd, '.contextignore');
    const block =
      `\n# Added by /kco-shield apply — files unused in 3+ sessions (${new Date().toISOString().slice(0, 10)})\n` +
      suggestions.map(s => s.pattern).join('\n') + '\n';
    appendFileSync(file, block);
    console.log(`\n  ✓ Appended ${suggestions.length} pattern(s) to ${file}`);
    console.log('  Reads of these files are now blocked (Grep still works). Edit the file to undo.\n');
  } else {
    console.log('\n  Run `/kco-shield apply` to append these to .contextignore.\n');
  }
}

function isTargetedRead(originalInput = {}) {
  if (Number.isFinite(originalInput.line_offset) && originalInput.line_offset !== 1) return true;
  if (Number.isFinite(originalInput.n_lines) && originalInput.n_lines < 1000) return true;
  if (Number.isFinite(originalInput.offset) && originalInput.offset !== 0) return true;
  if (Number.isFinite(originalInput.limit) && originalInput.limit < 1000) return true;
  return false;
}

async function hookMain(payload) {
  if (payload.hook_event_name !== 'PreToolUse') return;

  const originalInput = payload.tool_input && typeof payload.tool_input === 'object'
    ? payload.tool_input : {};
  const event = normalizeHookPayload(payload);
  if (event.tool_name !== 'Read') return;

  const toolInput = event.tool_input || {};
  const filePath = resolvePayloadPath(event, toolInput.path);
  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) return;

  const sessionId = event.session_id || 'unknown';
  const patterns = loadPatterns();
  const projectRoot = findProjectForPath(patterns, filePath);
  const proj = getProjectPatterns(patterns, projectRoot);

  try {
    const cwd = event.cwd || process.cwd();
    const ignoreSuggestions = buildIgnoreSuggestions(patterns, cwd, readIgnoreLines(cwd));
    const totalWaste = ignoreSuggestions.reduce((s, x) => s + x.tokens, 0);
    if (ignoreSuggestions.length && totalWaste >= 30_000) {
      const top = ignoreSuggestions.slice(0, 3).map(s => s.pattern).join(', ');
      emitNotice(sessionId, {
        kind: 'shield:ignore-suggest',
        text:
          `[context-shield] ${ignoreSuggestions.length} file(s) were read but never used in 3+ sessions ` +
          `(~${formatTokens(totalWaste)} estimated historical read volume/session). Top: ${top}. ` +
          `Run /kco-shield apply to stop those full reads.`,
      });
    }
  } catch { /* best effort; shield never blocks */ }

  const warnings = [];
  const wasteData = proj.wastedReads[filePath];
  if (wasteData && wasteData.sessions >= 5) {
    warnings.push(
      `[context-shield] ${basename(filePath)} went unused in ${wasteData.sessions} past sessions ` +
      `(~${formatTokens(wasteData.totalTokensWasted)} estimated historical read volume). ` +
      `Try Grep instead of reading the whole file.`
    );
  } else if (wasteData && wasteData.sessions >= 3) {
    warnings.push(
      `[context-shield] Heads up: ${basename(filePath)} wasn't needed in ${wasteData.sessions} past sessions. ` +
      `Try Grep or a targeted ReadFile line_offset/n_lines range.`
    );
  }

  if (!isTargetedRead(originalInput)) {
    const freqData = proj.fileFrequency[filePath];
    if (freqData && freqData.sessions >= 2) {
      const editRate = freqData.totalReads > 0 ? freqData.totalEdits / freqData.totalReads : 0;
      const usefulRatio = (freqData.usefulness || 0) / freqData.sessions;
      const isLegitReadOnly = usefulRatio >= 0.5;
      if (editRate < 0.1 && freqData.totalReads >= 5 && !isLegitReadOnly) {
        warnings.push(
          `[context-shield] ${basename(filePath)}: read ${freqData.totalReads}x but edited only ${freqData.totalEdits}x ` +
          `across ${freqData.sessions} sessions. Prefer a targeted ReadFile range.`
        );
      }
    }
  }

  if (proj.coOccurrence[filePath]) {
    const related = Object.entries(proj.coOccurrence[filePath])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, count]) => count >= 3);
    if (related.length > 0) {
      const names = related.map(([p]) => basename(p)).join(', ');
      warnings.push(
        `[context-shield] ${basename(filePath)} is often edited with: ${names}. ` +
        `If they are needed, load the relevant ranges together.`
      );
    }
  }

  if (warnings.length) {
    emitNotice(sessionId, { kind: `shield:${basename(filePath)}`, text: warnings[0] });
  }
}

if (isMainModule(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'suggest' || action === 'apply') {
    try { suggestOrApply(action); }
    catch { process.exit(0); }
  } else {
    runHook(hookMain);
  }
}
