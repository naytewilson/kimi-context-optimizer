#!/usr/bin/env node

/**
 * KCO Smart Read Cache — retroactive historical analysis (/kco-simulate).
 *
 * This module analyzes tracker history and asks which past full reads look
 * redundant under the read-cache invalidation rules. It does NOT replay Kimi,
 * does NOT know the counterfactual model-visible block overhead for those past
 * sessions, and therefore does NOT report causal "tokens saved".
 *
 * Output is ESTIMATED HISTORICAL AVOIDABLE-READ VOLUME. The runtime blocked-read
 * savings ledger in read-cache/dashboard is a separate metric.
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { SESSIONS_DIR, formatTokens, loadJSON, isMainModule } from './utils.js';

function loadSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => loadJSON(join(SESSIONS_DIR, f)))
    .filter(s => s && s.files && Object.keys(s.files).length > 0);
}

/**
 * Historical heuristic only. `avoidableTokensEstimated` is based on the
 * tracker's per-file token estimate and observed read/edit counts.
 */
function analyzeSession(session) {
  let totalReadVolumeEstimated = 0;
  let avoidableTokensEstimated = 0;
  let redundantReadsEstimated = 0;
  const fileOpportunities = [];

  for (const [filePath, f] of Object.entries(session.files || {})) {
    const tokensPerReadEstimated = f.estTokens || 0;
    const fullReads = f.fullReads || 0;
    const edits = f.edits || 0;
    const reads = f.reads || 0;

    totalReadVolumeEstimated += tokensPerReadEstimated * reads;

    // Historical approximation: one initial read plus one post-edit read per
    // edit would have been allowed. This does not model every real context or
    // range transition, hence the explicit ESTIMATED label.
    const allowedReads = f.wasEdited ? 1 + edits : 1;
    const redundant = Math.max(0, fullReads - allowedReads);
    if (redundant <= 0) continue;

    const volume = redundant * tokensPerReadEstimated;
    avoidableTokensEstimated += volume;
    redundantReadsEstimated += redundant;
    fileOpportunities.push({
      path: filePath,
      reads,
      redundantReadsEstimated: redundant,
      avoidableTokensEstimated: volume,
      tokensPerReadEstimated,
    });
  }

  return {
    // Legacy aliases retained for API compatibility, but both remain estimates.
    totalTokens: totalReadVolumeEstimated,
    savedTokens: avoidableTokensEstimated,
    redundantReads: redundantReadsEstimated,
    fileSavings: fileOpportunities.map(f => ({
      path: f.path,
      reads: f.reads,
      redundant: f.redundantReadsEstimated,
      saved: f.avoidableTokensEstimated,
      tokens: f.tokensPerReadEstimated,
    })),
    totalReadVolumeEstimated,
    avoidableTokensEstimated,
    redundantReadsEstimated,
    fileOpportunities,
    classification: 'ESTIMATED_HISTORICAL',
  };
}

function run() {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    console.log('No session data found. Use Kimi Code to generate tracking data first.');
    return;
  }

  let totalReadVolumeEstimated = 0;
  let avoidableTokensEstimated = 0;
  let redundantReadsEstimated = 0;
  const sessionResults = [];
  const globalFiles = new Map();

  for (const session of sessions) {
    const result = analyzeSession(session);
    totalReadVolumeEstimated += result.totalReadVolumeEstimated;
    avoidableTokensEstimated += result.avoidableTokensEstimated;
    redundantReadsEstimated += result.redundantReadsEstimated;

    const date = (session.startedAt || '').slice(0, 10);
    const project = session.projectRoot ? basename(session.projectRoot) : 'unknown';
    sessionResults.push({ date, project, ...result });

    for (const f of result.fileOpportunities) {
      const key = basename(f.path);
      const entry = globalFiles.get(key) || { reads: 0, redundant: 0, volume: 0 };
      entry.reads += f.reads;
      entry.redundant += f.redundantReadsEstimated;
      entry.volume += f.avoidableTokensEstimated;
      globalFiles.set(key, entry);
    }
  }

  const ratio = totalReadVolumeEstimated > 0
    ? ((avoidableTokensEstimated / totalReadVolumeEstimated) * 100).toFixed(1)
    : '0.0';

  let out = '\n';
  out += 'KCO SMART READ CACHE — RETROACTIVE ANALYSIS\n';
  out += '═'.repeat(62) + '\n\n';
  out += 'Evidence class: ESTIMATED HISTORICAL HEURISTIC\n';
  out += 'This is estimated historical avoidable-read volume, not the runtime blocked-read savings ledger.\n\n';
  out += `Sessions analyzed:                         ${sessions.length}\n`;
  out += `Estimated historical read volume:         ${formatTokens(totalReadVolumeEstimated)}\n`;
  out += `Estimated redundant full reads:            ${redundantReadsEstimated}\n`;
  out += `Estimated historical avoidable-read volume: ${formatTokens(avoidableTokensEstimated)} (${ratio}% of estimated historical read volume)\n`;

  const topSessions = sessionResults
    .filter(s => s.avoidableTokensEstimated > 0)
    .sort((a, b) => b.avoidableTokensEstimated - a.avoidableTokensEstimated)
    .slice(0, 10);

  if (topSessions.length > 0) {
    out += '\nTOP HISTORICAL OPPORTUNITIES\n';
    out += '─'.repeat(62) + '\n';
    for (const s of topSessions) {
      out += `  ${s.date} ${s.project.padEnd(18)} ~${formatTokens(s.avoidableTokensEstimated)} estimated avoidable read volume\n`;
    }
  }

  const topFiles = [...globalFiles.entries()]
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 10);
  if (topFiles.length > 0) {
    out += '\nTOP FILES BY ESTIMATED HISTORICAL AVOIDABLE-READ VOLUME\n';
    out += '─'.repeat(62) + '\n';
    for (const [name, f] of topFiles) {
      out += `  ${name.padEnd(22)} read ${String(f.reads).padStart(2)}x · ~${String(f.redundant).padStart(2)} redundant · ~${formatTokens(f.volume)} volume\n`;
    }
  }

  out += '\nUse /kco for the separate runtime counterfactual ledger, which subtracts model-visible KCO overhead.\n';
  console.log(out);
}

if (isMainModule(import.meta.url)) {
  try { run(); } catch (e) { console.error(`[kco] simulate error: ${e.message}`); process.exit(0); }
}

export { analyzeSession };
