#!/usr/bin/env node

/**
 * KCO Session Replay — Recent Session Summaries (/kco-replay).
 *
 * Shows summaries of recent sessions so the next session can
 * start with context about what was done previously.
 * (Near-verbatim port of the original replay.js — the summaries/*.txt
 * format is unchanged; tracker.js writes them at SessionEnd.)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SUMMARIES_DIR, getDonationMessage, isMainModule } from './utils.js';

function showReplay(count) {
  if (!existsSync(SUMMARIES_DIR)) {
    console.log('No session summaries yet.');
    return;
  }

  const files = readdirSync(SUMMARIES_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => {
      const fullPath = join(SUMMARIES_DIR, f);
      return { name: f, path: fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count);

  if (files.length === 0) {
    console.log('No session summaries yet.');
    return;
  }

  let output = '\n';
  output += `  ╔${'═'.repeat(62)}╗\n`;
  output += '  ║               KCO — RECENT SESSION SUMMARIES                ║\n';
  output += `  ╚${'═'.repeat(62)}╝\n`;

  for (let i = 0; i < files.length; i++) {
    const content = readFileSync(files[i].path, 'utf-8').trim();
    const lines = content.split('\n');

    output += '\n';
    output += `  [${i + 1}] ${lines[0]}\n`;
    for (let j = 1; j < lines.length; j++) {
      output += `      ${lines[j]}\n`;
    }
  }

  output += '\n  ─────────────────────────────────────────────────────────────\n';
  output += '  Tip: Start your session by reviewing these to avoid re-reading files!\n';

  output += getDonationMessage();

  console.log(output);
}

// ── CLI entry point ─────────────────────────────────────────────────────────

function main() {
  const count = parseInt(process.argv[2], 10) || 5;
  showReplay(count);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] replay error: ${e.message}`); process.exit(0); }
}

// Exposed for tests
export { showReplay };
