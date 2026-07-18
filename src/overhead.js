#!/usr/bin/env node

/**
 * KCO Session Baseline Overhead audit — /kco-overhead
 *
 * The biggest invisible token spend isn't redundant reads — it's the FIXED
 * overhead every session starts with: system prompt, tool schemas, AGENTS.md,
 * installed plugins, skill listings. You pay it before typing a word, and
 * again in every session.
 *
 * Port notes (vs the original claude-context-optimizer overhead.js):
 *   - MORE ACCURATE THAN THE ORIGINAL: the exact system-prompt size comes
 *     from the wire transcript's `config.update` record (systemPromptChars),
 *     not from inferring baseline usage off the first assistant message.
 *     The first `step.end` record still gives the full first-turn context.
 *   - Locally measurable overhead: AGENTS.md files (./AGENTS.md +
 *     ~/.agents/AGENTS.md), installed plugins under
 *     ~/.kimi-code/plugins/managed/<id>/kimi.plugin.json (name + skills
 *     count), and user skills (~/.kimi-code/skills/, ~/.agents/skills/).
 *   - The MCP-server audit is dropped (no equivalent config surface verified
 *     in Kimi Code); plugin/skill trimming takes its place.
 *
 * Usage:
 *   node src/overhead.js [wire.jsonl]   # specific wire transcript
 *   node src/overhead.js                # most recent wire transcript
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  formatTokens, estimateTokensFromString, loadConfig,
  getEffectiveBudget, isMainModule, getDonationMessage,
  computeCost, formatCost, loadJSON,
} from './utils.js';
import { getKimiHome } from './kimi-config.js';
import { findWireFile } from './wire-usage.js';

// ── Pure parsing (exported for tests) ───────────────────────────────────────

/**
 * Baseline from a wire.jsonl text:
 *   - systemPromptChars: EXACT system-prompt size from `config.update`
 *     (system prompt + tools + AGENTS.md + plugin/skill listings).
 *   - baselineTokens: the FIRST `step.end` record's total input — the context
 *     the model carried on its first turn, before any real work happened.
 * Returns { baselineTokens, systemPromptChars, model } — numbers may be 0/null.
 */
export function parseBaselineFromWire(text) {
  let systemPromptChars = 0;
  let baselineTokens = 0;
  let model = null;

  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'config.update' && typeof obj.systemPrompt === 'string') {
      systemPromptChars = obj.systemPrompt.length;
      continue;
    }
    if (typeof obj.model === 'string' && obj.model) {
      model = obj.model;
      continue;
    }
    if (obj.type === 'step.end' && obj.usage && typeof obj.usage === 'object') {
      const u = obj.usage;
      baselineTokens = (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
      break; // first step = baseline; stop here
    }
  }
  return { baselineTokens, systemPromptChars, model };
}

/** chars → tokens with the same heuristic as estimateTokensFromString. */
function charsToTokens(chars) {
  return Math.round((chars || 0) / 3.7);
}

// ── Locally measurable overhead sources ──────────────────────────────────────

function tokensOfFile(path, ext = '.md') {
  try {
    if (!existsSync(path)) return 0;
    return estimateTokensFromString(readFileSync(path, 'utf-8'), ext);
  } catch { return 0; }
}

/** Count SKILL.md files directly inside a skills dir (one level deep). */
function listSkillDirs(skillsRoot) {
  try {
    if (!existsSync(skillsRoot)) return [];
    return readdirSync(skillsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(skillsRoot, d.name))
      .filter(dir => existsSync(join(dir, 'SKILL.md')));
  } catch { return []; }
}

/**
 * What a skill costs the system prompt: its name + description from the
 * SKILL.md frontmatter is what lands in the skill listing.
 */
function tokensOfSkillDir(dir) {
  try {
    const content = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    return estimateTokensFromString(fm ? fm[1] : content.slice(0, 400));
  } catch { return 0; }
}

/** Installed plugins: getKimiHome()/plugins/managed/<id>/kimi.plugin.json. */
function collectPlugins() {
  const plugins = [];
  try {
    const managedDir = join(getKimiHome(), 'plugins', 'managed');
    if (!existsSync(managedDir)) return plugins;
    for (const entry of readdirSync(managedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(managedDir, entry.name);
      const manifestPath = join(pluginDir, 'kimi.plugin.json');
      const manifest = loadJSON(manifestPath);
      if (!manifest) continue;
      let skillCount = 0;
      let skillTokens = 0;
      const skillsRoot = typeof manifest.skills === 'string'
        ? join(pluginDir, manifest.skills) : null;
      if (skillsRoot) {
        const dirs = listSkillDirs(skillsRoot);
        skillCount = dirs.length;
        skillTokens = dirs.reduce((s, d) => s + tokensOfSkillDir(d), 0);
      }
      // The manifest's own name + description also ships in the listing.
      const manifestTokens = estimateTokensFromString(
        `${manifest.name || ''} ${manifest.description || ''}`);
      plugins.push({
        name: manifest.name || entry.name,
        skillCount,
        tokens: manifestTokens + skillTokens,
      });
    }
  } catch { /* best-effort */ }
  return plugins;
}

export function measureLocalSources(cwd) {
  const home = homedir();
  const items = [];

  const add = (label, tokens, hint) => {
    if (tokens > 0) items.push({ label, tokens, hint });
  };

  add('Project AGENTS.md', tokensOfFile(join(cwd, 'AGENTS.md')),
    'trim with /kco-agentsmd');
  add('Global ~/.agents/AGENTS.md', tokensOfFile(join(home, '.agents', 'AGENTS.md')),
    'loaded in EVERY project — keep it minimal');

  for (const p of collectPlugins()) {
    add(`Plugin: ${p.name} (${p.skillCount} skills)`, p.tokens,
      'uninstall plugins you never use — their skill listings load every session');
  }

  const kimiSkills = listSkillDirs(join(getKimiHome(), 'skills'));
  if (kimiSkills.length) {
    add(`User skills ~/.kimi-code/skills (${kimiSkills.length})`,
      kimiSkills.reduce((s, d) => s + tokensOfSkillDir(d), 0),
      'each skill description is in every system prompt');
  }
  const agentSkills = listSkillDirs(join(home, '.agents', 'skills'));
  if (agentSkills.length) {
    add(`User skills ~/.agents/skills (${agentSkills.length})`,
      agentSkills.reduce((s, d) => s + tokensOfSkillDir(d), 0),
      'remove skills you never invoke');
  }

  return items;
}

// ── Report ───────────────────────────────────────────────────────────────────

export function buildReport(cwd, wireArg) {
  const config = loadConfig();
  const budget = getEffectiveBudget(config);

  const wirePath = wireArg || findWireFile(null, cwd);

  const L = [];
  L.push('');
  L.push('  KCO SESSION BASELINE OVERHEAD');
  L.push('  ' + '─'.repeat(60));

  if (!wirePath || !existsSync(wirePath)) {
    L.push('  No wire transcript found yet.');
    L.push(`  Looked in: ${join(getKimiHome(), 'sessions', 'wd_*')}`);
    L.push('  Start a session, do one exchange, then run /kco-overhead again.');
    return L.join('\n');
  }

  let parsed;
  try {
    parsed = parseBaselineFromWire(readFileSync(wirePath, 'utf-8'));
  } catch {
    L.push('  Could not read the wire transcript — try again after one exchange.');
    return L.join('\n');
  }

  const systemTokens = charsToTokens(parsed.systemPromptChars);
  // The best single "fixed overhead" number: the exact system prompt when we
  // have it (it excludes the user's first prompt), else the first-step total.
  const overheadTokens = systemTokens > 0 ? systemTokens : parsed.baselineTokens;
  const pctOfBudget = budget > 0 ? Math.round((overheadTokens / budget) * 100) : 0;

  if (overheadTokens <= 0) {
    L.push('  The wire transcript has no usage records yet — run one exchange first.');
    return L.join('\n');
  }

  if (parsed.model) L.push(`  Model                         ${parsed.model}`);
  if (systemTokens > 0) {
    L.push(`  System prompt (exact)         ${formatTokens(systemTokens)} tokens (${parsed.systemPromptChars.toLocaleString()} chars — from wire config.update)`);
  }
  if (parsed.baselineTokens > 0 && parsed.baselineTokens !== systemTokens) {
    L.push(`  First-turn context total      ${formatTokens(parsed.baselineTokens)} tokens (incl. your first prompt)`);
  }
  L.push(`  Share of working budget       ${pctOfBudget}% of your ${formatTokens(budget)} budget, before any work`);
  const perSession = formatCost(computeCost(overheadTokens, 'input'));
  if (perSession) {
    L.push(`  Cost per session              ~${perSession} of input before you type`);
  }
  L.push('');

  const items = measureLocalSources(cwd).sort((a, b) => b.tokens - a.tokens);
  const itemized = items.reduce((s, i) => s + i.tokens, 0);
  const unattributed = Math.max(0, overheadTokens - itemized);

  L.push('  Where it goes (locally measurable):');
  for (const i of items) {
    L.push(`    ${i.label.padEnd(38)} ~${formatTokens(i.tokens).padStart(7)}   ${i.hint}`);
  }
  L.push(`    ${'Core system prompt & tool schemas'.padEnd(38)} ~${formatTokens(unattributed).padStart(7)}   fixed by the CLI — not trimmable`);
  L.push('');

  // ── Recommendations ──
  const recs = [];
  const projAgents = items.find(i => i.label === 'Project AGENTS.md');
  if (projAgents && projAgents.tokens > 3000) {
    recs.push(`Project AGENTS.md is ~${formatTokens(projAgents.tokens)} — run /kco-agentsmd to trim it.`);
  }
  const fattestPlugin = items.find(i => i.label.startsWith('Plugin:'));
  if (fattestPlugin) {
    recs.push(`${fattestPlugin.label} adds ~${formatTokens(fattestPlugin.tokens)} to every session — uninstall plugins you don't use.`);
  }
  const skillItem = items.find(i => i.label.startsWith('User skills'));
  if (skillItem) {
    recs.push(`User skill listings cost ~${formatTokens(skillItem.tokens)} per session — remove skills you never invoke.`);
  }
  if (pctOfBudget > 30) {
    recs.push(`Baseline eats ${pctOfBudget}% of your working budget before you type — every trim here repays in EVERY session.`);
  }
  if (recs.length) {
    L.push('  Recommendations:');
    for (const r of recs) L.push(`    • ${r}`);
  } else {
    L.push('  ✅ Baseline is lean for this model and budget.');
  }
  L.push(getDonationMessage());
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const arg = process.argv[2];
  console.log(buildReport(process.cwd(), arg));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] overhead error: ${e.message}`); process.exit(0); }
}
