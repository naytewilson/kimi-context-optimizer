#!/usr/bin/env node

/**
 * Context Optimizer Tracker v2.1 (KCO — Kimi Code port)
 *
 * Tracks file reads, edits, searches, and tool usage per session.
 * Features: ignore patterns, real-time waste warnings, partial read tracking,
 * co-occurrence matrix, project-segmented patterns, weighted usefulness scoring,
 * compact heatmap with actionable recommendations, data pruning.
 *
 * Port notes (vs the original claude-context-optimizer tracker.js):
 *   - Hook I/O goes through hook-io.js: payload from stdin via readPayload(),
 *     advisories on stdout via emitNotice()/advise(), always exit 0 (advisory
 *     hook — never blocks). runHook() enforces fail-open.
 *   - Tool input uses Kimi field names: Read/Edit/Write use `path` (NOT
 *     `file_path`), plus `offset`/`limit` on Read.
 *   - PostToolUse carries `tool_output` (the full result string) — its real
 *     length beats stat-based guessing for the per-call big-result advisory.
 *   - NEW: PostToolUseFailure events increment session.failures[tool] and
 *     session.failedCalls; after 3+ failures of the same tool, ONE advisory
 *     per session suggests correct usage.
 *   - NEW: SubagentStart/SubagentStop record session.delegations and subagent
 *     names (the PPID heuristic stays as a fallback in read-cache).
 *   - SessionStart nudge targets AGENTS.md (./AGENTS.md + ~/.agents/AGENTS.md).
 *   - SessionEnd calibrates token estimates against wire.jsonl ground truth
 *     (getSessionUsage) instead of Claude transcripts.
 *   - "CCO" → "KCO", "/cco" → "/kco" in all user-facing text.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import {
  DATA_DIR, SESSIONS_DIR, PATTERNS_FILE, GLOBAL_STATS_FILE, TEMPLATES_DIR, SUMMARIES_DIR,
  estimateTokens, estimateTokensFromString, formatTokens, displayPath, computeUsefulness,
  computeConfidence, getDonationMessage, loadJSON, saveJSON, ensureDataDirs,
  shouldIgnoreForTracking, getFileLines, getProjectRoot,
  acquireFileLock, updateCalibrationFromSession
} from './utils.js';
import { advise, isMainModule, runHook } from './hook-io.js';
import { emitNotice } from './notices.js';
import { getSessionUsage } from './wire-usage.js';

ensureDataDirs();

// Backwards-compatible local alias — use unified shouldIgnoreForTracking.
const shouldIgnore = shouldIgnoreForTracking;

// ── Session management ──────────────────────────────────────────────────────

function loadSession(sessionId) {
  const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
  if (existsSync(sessionFile)) {
    return JSON.parse(readFileSync(sessionFile, 'utf-8'));
  }
  return {
    id: sessionId,
    startedAt: new Date().toISOString(),
    projectRoot: null,
    files: {},
    searches: [],
    tools: {},
    compactions: 0,
    totalReads: 0,
    totalEdits: 0,
    totalSearches: 0,
    totalToolCalls: 0,
    failures: {},
    failedCalls: 0,
    delegations: 0,
    subagents: [],
  };
}

function saveSession(session) {
  const sessionFile = join(SESSIONS_DIR, `${session.id}.json`);
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}

// ── Patterns (project-segmented) ────────────────────────────────────────────

function loadPatterns() {
  const data = loadJSON(PATTERNS_FILE);
  if (!data) {
    return { projects: {}, taskPatterns: {}, lastUpdated: null };
  }
  // Migrate old flat format to project-segmented
  if (data.fileFrequency && !data.projects) {
    return {
      projects: {
        _global: {
          fileFrequency: data.fileFrequency || {},
          wastedReads: data.wastedReads || {},
          coOccurrence: {},
        }
      },
      taskPatterns: data.taskPatterns || {},
      lastUpdated: data.lastUpdated
    };
  }
  return data;
}

function getProjectPatterns(patterns, projectRoot) {
  const key = projectRoot || '_global';
  if (!patterns.projects[key]) {
    patterns.projects[key] = {
      fileFrequency: {},
      wastedReads: {},
      coOccurrence: {},
    };
  }
  return patterns.projects[key];
}

function savePatterns(patterns) {
  patterns.lastUpdated = new Date().toISOString();
  saveJSON(PATTERNS_FILE, patterns);
}

// ── Global stats ────────────────────────────────────────────────────────────

function loadGlobalStats() {
  return loadJSON(GLOBAL_STATS_FILE) || {
    totalSessions: 0,
    totalTokensTracked: 0,
    estimatedTokensSaved: 0,
    totalFilesRead: 0,
    totalFilesEdited: 0,
    avgTokensPerSession: 0,
    topWastedFiles: [],
    topUsefulFiles: [],
    sessionHistory: []
  };
}

// ── Tracking functions ──────────────────────────────────────────────────────

function trackRead(session, filePath, lineCount, readOptions = {}) {
  if (shouldIgnore(filePath)) return { ignored: true };

  const ext = extname(filePath);
  const tokens = estimateTokens(lineCount, ext);
  const isPartial = !!(readOptions.offset || readOptions.limit);

  if (!session.files[filePath]) {
    session.files[filePath] = {
      reads: 0,
      edits: 0,
      lines: lineCount,
      estTokens: tokens,
      firstRead: new Date().toISOString(),
      lastUse: null,
      wasEdited: false,
      partialReads: 0,
      fullReads: 0,
    };
  }

  const file = session.files[filePath];
  file.reads++;
  file.lastUse = new Date().toISOString();
  file.lines = lineCount;
  file.estTokens = tokens;

  if (isPartial) {
    file.partialReads++;
  } else {
    file.fullReads++;
  }

  session.totalReads++;

  if (!session.projectRoot) {
    session.projectRoot = getProjectRoot(filePath);
  }

  // ── Real-time warnings ──
  const warnings = [];

  if (file.reads >= 3 && !file.wasEdited) {
    const totalTokensSpent = file.estTokens * file.reads;
    if (file.reads === 3) {
      warnings.push(
        `[kco] ${basename(filePath)} read ${file.reads}x (~${formatTokens(totalTokensSpent)} tokens). ` +
        `Consider offset/limit for specific sections.`
      );
    } else if (file.reads === 5) {
      warnings.push(
        `[kco] ${basename(filePath)} read ${file.reads}x (~${formatTokens(totalTokensSpent)} tokens). ` +
        `Add key parts to AGENTS.md or memory to avoid re-reads.`
      );
    } else if (file.reads % 5 === 0) {
      warnings.push(
        `[kco] ${basename(filePath)} read ${file.reads}x (~${formatTokens(totalTokensSpent)} tokens) with 0 edits!`
      );
    }
  }

  if (file.reads === 1) {
    try {
      const patterns = loadPatterns();
      const proj = getProjectPatterns(patterns, session.projectRoot);
      const wasteData = proj.wastedReads[filePath];
      if (wasteData && wasteData.sessions >= 3) {
        warnings.push(
          `[kco] ${basename(filePath)} was unused in ${wasteData.sessions} past sessions (~${formatTokens(wasteData.totalTokensWasted)} wasted). Try Grep for specific content instead.`
        );
      } else if (wasteData && wasteData.sessions >= 2) {
        warnings.push(
          `[kco] ${basename(filePath)} was wasted in ${wasteData.sessions} past sessions. Consider skipping.`
        );
      }
    } catch { /* don't block on pattern load failure */ }
  }

  if (!isPartial && lineCount > 500) {
    warnings.push(
      `[kco] ${basename(filePath)} is ${lineCount} lines (~${formatTokens(tokens)} tokens). Use offset/limit to read specific sections.`
    );
  } else if (!isPartial && lineCount > 200) {
    // Softer hint for medium files
    if (file.reads === 1) {
      warnings.push(
        `[kco] ${basename(filePath)}: ${lineCount} lines read fully. Next time, try offset/limit if you only need part of it.`
      );
    }
  }

  // Gate advisory output through the per-session noise budget so the optimizer
  // doesn't spend Kimi's context narrating. At most one line per read, keyed
  // per file (no repeat nags), and a few per session total (cap shared with
  // budget notices). The data is still tracked — it just stops shouting.
  if (warnings.length && session.id) {
    emitNotice(session.id, { kind: `track:${basename(filePath)}`, text: warnings[0] });
  }

  return { ignored: false, warnings };
}

function trackEdit(session, filePath) {
  if (shouldIgnore(filePath)) return;

  if (!session.files[filePath]) {
    session.files[filePath] = {
      reads: 0,
      edits: 0,
      lines: 0,
      estTokens: 0,
      firstRead: new Date().toISOString(),
      lastUse: null,
      wasEdited: true,
      partialReads: 0,
      fullReads: 0,
    };
  }

  session.files[filePath].edits++;
  session.files[filePath].wasEdited = true;
  session.files[filePath].lastUse = new Date().toISOString();
  session.totalEdits++;

  if (!session.projectRoot) {
    session.projectRoot = getProjectRoot(filePath);
  }
}

function trackSearch(session, pattern, type) {
  session.searches.push({
    pattern,
    type,
    ts: new Date().toISOString()
  });
  // The session file is rewritten on every tool call — keep the log bounded
  // (totalSearches keeps the true count; only the detail list is trimmed).
  if (session.searches.length > 300) session.searches.splice(0, session.searches.length - 300);
  session.totalSearches++;
}

function trackToolUse(session, toolName) {
  if (!session.tools[toolName]) {
    session.tools[toolName] = { calls: 0 };
  }
  session.tools[toolName].calls++;
  session.totalToolCalls++;
}

// ── Delegation advisor ──────────────────────────────────────────────────────
// A long run of Read/Grep/Glob with zero edits is exploration — and every one
// of those results sits in the MAIN context forever. A subagent does the same
// exploration in its own context, which is discarded; only the summary comes
// back. Detect the pattern live and suggest delegating, once per session.

const EXPLORE_STREAK_CALLS = 12;
const EXPLORE_STREAK_TOKENS = 20_000;

/** Update the read-only exploration streak. Returns true when it's time to
 *  suggest delegation (fires at most once per session). Pure on `session`. */
export function updateExploreStreak(session, toolName, tokensAdded = 0) {
  if (!session.explore) session.explore = { streak: 0, streakTokens: 0, advised: false };
  const e = session.explore;
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    e.streak++;
    e.streakTokens += tokensAdded;
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Agent' || toolName === 'AgentSwarm') {
    // An edit means the exploration paid off; an Agent call means the user's
    // Kimi is already delegating. Either way — reset.
    e.streak = 0;
    e.streakTokens = 0;
  }
  if (!e.advised && e.streak >= EXPLORE_STREAK_CALLS && e.streakTokens >= EXPLORE_STREAK_TOKENS) {
    e.advised = true;
    return true;
  }
  return false;
}

// ── Failure advisor (KCO addition — PostToolUseFailure) ─────────────────────
// A tool failing repeatedly usually means the model is calling it wrong (bad
// field names, missing params). After 3 failures of the same tool, emit ONE
// advisory per session with the correct Kimi usage for that tool.

const FAILURE_ADVISORY_THRESHOLD = 3;

const TOOL_USAGE_HINTS = {
  Read: 'Read takes { path, offset?, limit? } — path is absolute, offset/limit select a line range.',
  Edit: 'Edit takes { path, old_string, new_string } — old_string must match the file content exactly.',
  Write: 'Write takes { path, content } — path is absolute; parent dirs are created automatically.',
  Grep: 'Grep takes { pattern, path?, glob? } — ripgrep regex syntax.',
  Glob: 'Glob takes { pattern, path? } — e.g. "src/**/*.ts".',
  Bash: 'Bash takes { command } — quote paths with spaces; avoid interactive/long-running commands.',
  Agent: 'Agent takes { prompt, description, subagent_type? } — brief the subagent fully; it has zero context.',
};

/**
 * Record a tool failure. Returns the advisory text when the threshold is
 * crossed for the first time this session, else null. Pure on `session`.
 */
export function trackFailure(session, toolName, error) {
  if (!session.failures) session.failures = {};
  if (typeof session.failedCalls !== 'number') session.failedCalls = 0;
  session.failures[toolName] = (session.failures[toolName] || 0) + 1;
  session.failedCalls++;

  if (session.failures[toolName] !== FAILURE_ADVISORY_THRESHOLD) return null;

  const hint = TOOL_USAGE_HINTS[toolName] ||
    `${toolName} keeps failing — check its required input fields before retrying.`;
  const errMsg = error && typeof error.message === 'string'
    ? error.message.split('\n')[0].slice(0, 120)
    : 'unknown error';
  return (
    `[kco] ${toolName} failed ${session.failures[toolName]}x this session (last: ${errMsg}). ` +
    `Correct usage: ${hint}`
  );
}

// ── Data pruning ────────────────────────────────────────────────────────────

function prunePatterns(patterns) {
  for (const [, proj] of Object.entries(patterns.projects)) {
    // Cap co-occurrence entries per file to top 20
    for (const [file, related] of Object.entries(proj.coOccurrence || {})) {
      const entries = Object.entries(related);
      if (entries.length > 20) {
        const top = entries.sort((a, b) => b[1] - a[1]).slice(0, 20);
        proj.coOccurrence[file] = Object.fromEntries(top);
      }
    }

    // Cap wasted reads to top 100
    const wastedEntries = Object.entries(proj.wastedReads || {});
    if (wastedEntries.length > 100) {
      const top = wastedEntries
        .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted)
        .slice(0, 100);
      proj.wastedReads = Object.fromEntries(top);
    }

    // Cap file frequency to top 200
    const freqEntries = Object.entries(proj.fileFrequency || {});
    if (freqEntries.length > 200) {
      const top = freqEntries
        .sort((a, b) => b[1].sessions - a[1].sessions)
        .slice(0, 200);
      proj.fileFrequency = Object.fromEntries(top);
    }
  }
}

// ── Session finalization ────────────────────────────────────────────────────

function finalizeSession(session) {
  const fileEntries = Object.entries(session.files);
  // Skip finalization for empty sessions
  if (fileEntries.length === 0) {
    saveSession(session);
    return { sessionTokensTotal: 0, sessionTokensWasted: 0 };
  }

  // Serialize the global read-modify-write: two sessions finalizing at once
  // would otherwise clobber each other's stats (last-writer-wins).
  const releaseGlobals = acquireFileLock('globals');
  try {

  const patterns = loadPatterns();
  const globalStats = loadGlobalStats();
  const proj = getProjectPatterns(patterns, session.projectRoot);

  let sessionTokensTotal = 0;
  let sessionTokensWasted = 0;
  const editedFiles = [];

  for (const [filePath, fileData] of fileEntries) {
    const tokensUsed = fileData.estTokens * fileData.reads;
    sessionTokensTotal += tokensUsed;

    const usefulness = computeUsefulness(fileData);
    const isUseful = usefulness > 0;

    if (!isUseful && fileData.reads >= 1) {
      sessionTokensWasted += tokensUsed;

      if (!proj.wastedReads[filePath]) {
        proj.wastedReads[filePath] = { count: 0, sessions: 0, totalTokensWasted: 0 };
      }
      proj.wastedReads[filePath].count++;
      proj.wastedReads[filePath].sessions++;
      proj.wastedReads[filePath].totalTokensWasted += tokensUsed;
    }

    if (!proj.fileFrequency[filePath]) {
      proj.fileFrequency[filePath] = { sessions: 0, totalReads: 0, totalEdits: 0, usefulness: 0, lastSeen: null, confidence: 0 };
    }
    proj.fileFrequency[filePath].sessions++;
    proj.fileFrequency[filePath].totalReads += fileData.reads;
    proj.fileFrequency[filePath].totalEdits += fileData.edits;
    proj.fileFrequency[filePath].lastSeen = new Date().toISOString();
    if (isUseful) {
      proj.fileFrequency[filePath].usefulness++;
    }
    // Update confidence score
    proj.fileFrequency[filePath].confidence = computeConfidence(proj.fileFrequency[filePath], 0);

    if (fileData.wasEdited) {
      editedFiles.push(filePath);
    }
  }

  // Build co-occurrence matrix
  if (editedFiles.length >= 2 && editedFiles.length <= 20) {
    for (let i = 0; i < editedFiles.length; i++) {
      const a = editedFiles[i];
      if (!proj.coOccurrence[a]) proj.coOccurrence[a] = {};
      for (let j = 0; j < editedFiles.length; j++) {
        if (i === j) continue;
        const b = editedFiles[j];
        proj.coOccurrence[a][b] = (proj.coOccurrence[a][b] || 0) + 1;
      }
    }
  }

  // Prune patterns to prevent unbounded growth
  prunePatterns(patterns);

  // Update global stats
  globalStats.totalSessions++;
  globalStats.totalTokensTracked += sessionTokensTotal;
  // NOTE: legacy field name — it holds cumulative WASTE (all consumers label it
  // "wasted"); kept as-is for state-file back-compat with existing installs.
  globalStats.estimatedTokensSaved += sessionTokensWasted;
  globalStats.totalFilesRead += session.totalReads;
  globalStats.totalFilesEdited += session.totalEdits;
  globalStats.avgTokensPerSession = Math.round(
    globalStats.totalTokensTracked / globalStats.totalSessions
  );

  globalStats.sessionHistory.push({
    id: session.id,
    date: new Date().toISOString(),
    project: session.projectRoot ? basename(session.projectRoot) : null,
    filesRead: fileEntries.length,
    totalReads: session.totalReads,
    totalEdits: session.totalEdits,
    tokensTotal: sessionTokensTotal,
    tokensWasted: sessionTokensWasted,
    wastePercent: sessionTokensTotal > 0 ?
      Math.round((sessionTokensWasted / sessionTokensTotal) * 100) : 0
  });
  if (globalStats.sessionHistory.length > 100) {
    globalStats.sessionHistory = globalStats.sessionHistory.slice(-100);
  }

  // Aggregate top files across all projects
  const allWasted = {};
  const allUseful = {};
  for (const [, projData] of Object.entries(patterns.projects)) {
    for (const [path, data] of Object.entries(projData.wastedReads || {})) {
      if (!allWasted[path] || allWasted[path].totalTokensWasted < data.totalTokensWasted) {
        allWasted[path] = data;
      }
    }
    for (const [path, data] of Object.entries(projData.fileFrequency || {})) {
      if (data.usefulness > 0) {
        if (!allUseful[path] || allUseful[path].usefulness < data.usefulness) {
          allUseful[path] = data;
        }
      }
    }
  }

  globalStats.topWastedFiles = Object.entries(allWasted)
    .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  globalStats.topUsefulFiles = Object.entries(allUseful)
    .filter(([, data]) => data.usefulness > 0)
    .sort((a, b) => b[1].usefulness - a[1].usefulness)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  savePatterns(patterns);
  saveJSON(GLOBAL_STATS_FILE, globalStats);
  saveSession(session);

  // Auto-create template if 5+ sessions in project and none exists
  autoCreateTemplate(session.projectRoot, proj);

  return { sessionTokensTotal, sessionTokensWasted };

  } finally {
    releaseGlobals();
  }
}

// ── Auto-template creation ──────────────────────────────────────────────────

function autoCreateTemplate(projectRoot, proj) {
  if (!projectRoot) return;
  try {
    const projectName = basename(projectRoot);
    const templateFile = join(TEMPLATES_DIR, `auto-${projectName}.json`);
    if (existsSync(templateFile)) return; // already exists

    // Need enough sessions worth of data for reliable patterns
    const frequentFiles = Object.entries(proj.fileFrequency || {})
      .filter(([, d]) => d.usefulness >= 3 && d.totalEdits >= 2)
      .sort((a, b) => b[1].usefulness - a[1].usefulness)
      .slice(0, 8);

    if (frequentFiles.length < 3) return; // not enough data

    const template = {
      name: `auto-${projectName}`,
      description: `Auto-generated template for ${projectName} based on ${Object.values(proj.fileFrequency).reduce((s, d) => s + d.sessions, 0)} file interactions`,
      autoGenerated: true,
      files: frequentFiles.map(([path]) => path.replace(projectRoot + '/', '')),
      createdAt: new Date().toISOString()
    };

    saveJSON(templateFile, template);
  } catch { /* don't block on template creation failure */ }
}

// ── Savings calculation ─────────────────────────────────────────────────────

function calculateWeeklySavings(globalStats) {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recent = (globalStats.sessionHistory || [])
    .filter(s => new Date(s.date) >= weekAgo && s.tokensTotal > 0);

  if (recent.length < 2) return null;

  // Compare first half vs second half waste
  const mid = Math.floor(recent.length / 2);
  const first = recent.slice(0, mid);
  const second = recent.slice(mid);

  const firstAvgWaste = first.reduce((s, x) => s + x.wastePercent, 0) / first.length;
  const secondAvgWaste = second.reduce((s, x) => s + x.wastePercent, 0) / second.length;

  const totalTokens = recent.reduce((s, x) => s + x.tokensTotal, 0);
  const totalWasted = recent.reduce((s, x) => s + x.tokensWasted, 0);
  const improvement = firstAvgWaste - secondAvgWaste;

  return {
    sessions: recent.length,
    totalTokens,
    totalWasted,
    avgWaste: Math.round((totalWasted / totalTokens) * 100),
    improving: improvement > 3,
    improvementPct: Math.round(improvement)
  };
}

// ── Rebuild global stats ────────────────────────────────────────────────────

function rebuildGlobalStats() {
  const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  if (sessionFiles.length === 0) return;

  const patterns = { projects: {}, taskPatterns: {}, lastUpdated: null };
  const globalStats = {
    totalSessions: 0, totalTokensTracked: 0, estimatedTokensSaved: 0,
    totalFilesRead: 0, totalFilesEdited: 0, avgTokensPerSession: 0,
    topWastedFiles: [], topUsefulFiles: [], sessionHistory: []
  };

  for (const file of sessionFiles) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
      const fileEntries = Object.entries(session.files || {});

      // Skip empty sessions
      if (fileEntries.length === 0) continue;

      const projKey = session.projectRoot || '_global';
      if (!patterns.projects[projKey]) {
        patterns.projects[projKey] = { fileFrequency: {}, wastedReads: {}, coOccurrence: {} };
      }
      const proj = patterns.projects[projKey];

      let sessionTokensTotal = 0;
      let sessionTokensWasted = 0;

      for (const [filePath, fileData] of fileEntries) {
        if (shouldIgnore(filePath)) continue;

        const tokensUsed = (fileData.estTokens || 0) * (fileData.reads || 1);
        sessionTokensTotal += tokensUsed;
        const usefulness = computeUsefulness(fileData);
        const isUseful = usefulness > 0;

        if (!isUseful && (fileData.reads || 0) >= 1) {
          sessionTokensWasted += tokensUsed;
          if (!proj.wastedReads[filePath]) {
            proj.wastedReads[filePath] = { count: 0, sessions: 0, totalTokensWasted: 0 };
          }
          proj.wastedReads[filePath].count++;
          proj.wastedReads[filePath].sessions++;
          proj.wastedReads[filePath].totalTokensWasted += tokensUsed;
        }

        if (!proj.fileFrequency[filePath]) {
          proj.fileFrequency[filePath] = { sessions: 0, totalReads: 0, totalEdits: 0, usefulness: 0 };
        }
        proj.fileFrequency[filePath].sessions++;
        proj.fileFrequency[filePath].totalReads += fileData.reads || 0;
        proj.fileFrequency[filePath].totalEdits += fileData.edits || 0;
        if (isUseful) proj.fileFrequency[filePath].usefulness++;
      }

      globalStats.totalSessions++;
      globalStats.totalTokensTracked += sessionTokensTotal;
      globalStats.estimatedTokensSaved += sessionTokensWasted;
      globalStats.totalFilesRead += session.totalReads || 0;
      globalStats.totalFilesEdited += session.totalEdits || 0;

      globalStats.sessionHistory.push({
        id: session.id, date: session.startedAt || new Date().toISOString(),
        project: session.projectRoot ? basename(session.projectRoot) : null,
        filesRead: fileEntries.length,
        totalReads: session.totalReads || 0, totalEdits: session.totalEdits || 0,
        tokensTotal: sessionTokensTotal, tokensWasted: sessionTokensWasted,
        wastePercent: sessionTokensTotal > 0 ? Math.round((sessionTokensWasted / sessionTokensTotal) * 100) : 0
      });
    } catch { /* skip corrupted session files */ }
  }

  if (globalStats.totalSessions > 0) {
    globalStats.avgTokensPerSession = Math.round(globalStats.totalTokensTracked / globalStats.totalSessions);
  }
  globalStats.sessionHistory = globalStats.sessionHistory.slice(-100);

  // Aggregate top files
  const allWasted = {};
  const allUseful = {};
  for (const [, projData] of Object.entries(patterns.projects)) {
    for (const [path, data] of Object.entries(projData.wastedReads || {})) {
      if (!allWasted[path] || allWasted[path].totalTokensWasted < data.totalTokensWasted) allWasted[path] = data;
    }
    for (const [path, data] of Object.entries(projData.fileFrequency || {})) {
      if (data.usefulness > 0 && (!allUseful[path] || allUseful[path].usefulness < data.usefulness)) allUseful[path] = data;
    }
  }

  globalStats.topWastedFiles = Object.entries(allWasted)
    .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted).slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  globalStats.topUsefulFiles = Object.entries(allUseful)
    .sort((a, b) => b[1].usefulness - a[1].usefulness).slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  prunePatterns(patterns);
  savePatterns(patterns);
  saveJSON(GLOBAL_STATS_FILE, globalStats);
}

// ── Session summary for replay ──────────────────────────────────────────────

function generateSessionSummary(session) {
  const fileEntries = Object.entries(session.files).filter(([p]) => !shouldIgnore(p));
  if (fileEntries.length === 0) return null;

  const editedFiles = fileEntries
    .filter(([, d]) => d.wasEdited)
    .map(([p]) => basename(p));
  const totalReads = fileEntries.length;

  let totalTokens = 0;
  let wastedTokens = 0;
  for (const [, fileData] of fileEntries) {
    const tokensUsed = fileData.estTokens * fileData.reads;
    totalTokens += tokensUsed;
    const usefulness = computeUsefulness(fileData);
    if (usefulness <= 0 && fileData.reads >= 1) {
      wastedTokens += tokensUsed;
    }
  }

  const wastePercent = totalTokens > 0
    ? Math.round((wastedTokens / totalTokens) * 100)
    : 0;

  // Calculate session duration
  const start = new Date(session.startedAt);
  const end = session.updatedAt ? new Date(session.updatedAt) : new Date();
  const durationMin = Math.max(1, Math.round((end - start) / 60000));

  // Format timestamp in local wall-clock time (sv-SE = "YYYY-MM-DD HH:MM")
  const dateStr = start.toLocaleString('sv-SE').slice(0, 16);

  const lines = [`Session ${dateStr} (${durationMin} min)`];

  if (editedFiles.length > 0) {
    const display = editedFiles.length <= 5
      ? editedFiles.join(', ')
      : editedFiles.slice(0, 4).join(', ') + `, +${editedFiles.length - 4} more`;
    lines.push(`Edited: ${display} (${editedFiles.length} file${editedFiles.length !== 1 ? 's' : ''})`);
  } else {
    lines.push('Read-only session (no edits)');
  }

  lines.push(`Context: ${formatTokens(totalTokens)} tokens, ${totalReads} files read, ${wastePercent}% waste`);

  return lines.join('\n');
}

// ── Compact heatmap with disambiguated paths ────────────────────────────────

function generateHeatmap(session) {
  const files = Object.entries(session.files)
    .filter(([path]) => !shouldIgnore(path))
    .sort((a, b) => b[1].estTokens * b[1].reads - a[1].estTokens * a[1].reads);

  if (files.length === 0) return 'No files tracked in this session.';

  const maxTokens = Math.max(...files.map(([, d]) => d.estTokens * d.reads));
  const barWidth = 30;

  let totalTokens = 0;
  let wastedTokens = 0;
  let totalPartialReads = 0;
  let totalFullReads = 0;
  const wasteFiles = [];
  const heavyRereadFiles = [];

  let output = '\n  CONTEXT HEATMAP\n';
  output += '  ' + '='.repeat(76) + '\n';
  output += '  File'.padEnd(39) + 'Tokens'.padStart(7) + ' Rds Eds  Impact\n';
  output += '  ' + '-'.repeat(76) + '\n';

  for (const [filePath, data] of files) {
    const totalTok = data.estTokens * data.reads;
    totalTokens += totalTok;
    const usefulness = computeUsefulness(data);
    const isUseful = usefulness > 0;

    if (!isUseful) {
      wastedTokens += totalTok;
      wasteFiles.push({ name: displayPath(filePath, 30), tokens: totalTok, reads: data.reads });
    }
    if (data.reads >= 3 && !data.wasEdited) {
      heavyRereadFiles.push({ name: displayPath(filePath, 30), tokens: totalTok, reads: data.reads });
    }

    totalPartialReads += data.partialReads || 0;
    totalFullReads += data.fullReads || 0;

    const barLen = Math.max(1, Math.round((totalTok / maxTokens) * barWidth));
    const bar = isUseful ? '█'.repeat(barLen) : '░'.repeat(barLen);
    const icon = data.wasEdited ? '✏' : (data.reads > 1 ? '✔' : '⚠');
    const name = displayPath(filePath, 34);
    const partial = (data.partialReads || 0) > 0 ? '↗' : ' ';

    output += `  ${icon}${partial}${name.padEnd(36)} ${formatTokens(totalTok).padStart(6)} ${String(data.reads).padStart(3)} ${String(data.edits).padStart(3)}  ${bar}\n`;
  }

  const wastePercent = totalTokens > 0 ? Math.round((wastedTokens / totalTokens) * 100) : 0;
  const partialPercent = (totalPartialReads + totalFullReads) > 0 ?
    Math.round((totalPartialReads / (totalPartialReads + totalFullReads)) * 100) : 0;

  output += '  ' + '-'.repeat(76) + '\n';
  output += `  ${formatTokens(totalTokens)} total | ${formatTokens(wastedTokens)} waste (${wastePercent}%) | ${partialPercent}% partial reads\n`;

  output += '\n  ACTIONS\n';
  output += '  ' + '-'.repeat(76) + '\n';

  if (wasteFiles.length > 0) {
    const topWaste = wasteFiles.sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    for (const f of topWaste) {
      output += `  💤 ${f.name}: read but unused (${formatTokens(f.tokens)}, ${f.reads} read${f.reads > 1 ? 's' : ''}). Skip next time?\n`;
    }
  }

  if (heavyRereadFiles.length > 0) {
    for (const f of heavyRereadFiles.slice(0, 2)) {
      output += `  🔄 ${f.name}: re-read ${f.reads}x — add key info to AGENTS.md to avoid this\n`;
    }
  }

  if (partialPercent < 20 && totalTokens > 10000) {
    output += `  💡 Only ${partialPercent}% partial reads — use offset/limit on large files to save tokens\n`;
  }

  if (wastePercent <= 15) {
    output += `  🎯 Efficient session — only ${wastePercent}% waste. Nice!\n`;
  }

  output += '\n  ✏=edited  ✔=useful read  💤=unused  💡=partial\n';
  output += getDonationMessage();
  output += '\n';
  return output;
}

// ── Smart suggestions ───────────────────────────────────────────────────────

function generateSuggestions(cwd) {
  const patterns = loadPatterns();
  const globalStats = loadGlobalStats();

  const suggestions = { preload: [], avoid: [], coRelated: [], tips: [] };

  // Find matching project
  let proj = null;
  for (const [key, data] of Object.entries(patterns.projects)) {
    if (cwd.startsWith(key) || key === '_global') {
      proj = data;
      break;
    }
  }
  if (!proj) proj = getProjectPatterns(patterns, cwd);

  // Files that are almost always useful — using confidence scoring
  const now = new Date();
  for (const [filePath, data] of Object.entries(proj.fileFrequency)) {
    if (filePath.startsWith(cwd) && data.usefulness >= 2 && data.totalEdits > 0) {
      const daysSince = data.lastSeen
        ? Math.round((now - new Date(data.lastSeen)) / (1000 * 60 * 60 * 24))
        : 30;
      const confidence = computeConfidence(data, daysSince);
      suggestions.preload.push({
        file: filePath,
        reason: `Edited in ${data.totalEdits}/${data.sessions} sessions`,
        confidence: Math.round(confidence * 100)
      });
    }
  }

  // Files frequently wasted
  for (const [filePath, data] of Object.entries(proj.wastedReads)) {
    if (data.sessions >= 2 && data.totalTokensWasted > 500) {
      suggestions.avoid.push({
        file: filePath,
        reason: `Wasted in ${data.sessions} sessions (~${formatTokens(data.totalTokensWasted)} tokens)`,
        tokensSaveable: data.totalTokensWasted
      });
    }
  }

  // Co-occurrence suggestions
  for (const [filePath, related] of Object.entries(proj.coOccurrence || {})) {
    if (!filePath.startsWith(cwd)) continue;
    const top = Object.entries(related)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, count]) => count >= 2);

    if (top.length > 0) {
      suggestions.coRelated.push({
        file: basename(filePath),
        relatedTo: top.map(([p, c]) => ({ file: basename(p), coSessions: c }))
      });
    }
  }

  // Tips
  if (globalStats.totalSessions > 3) {
    const recentHistory = globalStats.sessionHistory.slice(-10);
    const avgWaste = recentHistory.reduce((sum, s) => sum + s.wastePercent, 0) /
      Math.min(10, recentHistory.length);

    if (avgWaste > 30) {
      suggestions.tips.push(
        `Average waste is ${Math.round(avgWaste)}%. Use Grep/Glob to find files before reading.`
      );
    }

    if (globalStats.avgTokensPerSession > 50000) {
      suggestions.tips.push(
        `Avg session: ~${formatTokens(globalStats.avgTokensPerSession)} tokens. Consider task splitting.`
      );
    }
  }

  suggestions.preload.sort((a, b) => b.confidence - a.confidence);
  suggestions.avoid.sort((a, b) => b.tokensSaveable - a.tokensSaveable);

  return suggestions;
}

// ── Hook event handler ──────────────────────────────────────────────────────

async function handleHookEvent(event) {
  const sessionId = event.session_id || 'unknown';
  const session = loadSession(sessionId);
  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};
  const hookEvent = event.hook_event_name || '';

  switch (hookEvent) {
    case 'PostToolUse': {
      trackToolUse(session, toolName);

      if (toolName === 'Read') {
        const filePath = toolInput.path || '';
        const lineCount = toolInput.limit || getFileLines(filePath);
        trackRead(session, filePath, lineCount, {
          offset: toolInput.offset,
          limit: toolInput.limit,
        });
      }

      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = toolInput.path || '';
        trackEdit(session, filePath);
      }

      if (toolName === 'Glob' || toolName === 'Grep') {
        const pattern = toolInput.pattern || '';
        trackSearch(session, pattern, toolName);
      }

      if (toolName === 'Agent') {
        trackToolUse(session, `Agent:${toolInput.subagent_type || 'general'}`);
      }

      // ── Big-result advisory ──
      // A single huge tool result is the #1 avoidable context burn. Kimi's
      // PostToolUse payload carries the FULL tool_output string, so measure
      // its real length instead of stat-based guessing. One line per session.
      if (typeof event.tool_output === 'string' && event.tool_output) {
        const outTokens = estimateTokensFromString(event.tool_output);
        if (outTokens >= 10_000) {
          const fix = toolName === 'Read'
            ? 'read with offset/limit or Grep the file instead'
            : toolName === 'Bash'
              ? 'pipe through tail/head/grep next time'
              : 'narrow the query';
          emitNotice(sessionId, {
            kind: 'track:bigresult',
            text: `[kco] ${toolName} result was ~${formatTokens(outTokens)} tokens — ${fix}.`,
          });
        }
      }

      // ── Delegation advisor ──
      {
        let tokensAdded = 0;
        if (toolName === 'Read') {
          const fp = toolInput.path || '';
          // Prefer the real output size; fall back to the tracked estimate.
          tokensAdded = typeof event.tool_output === 'string' && event.tool_output
            ? estimateTokensFromString(event.tool_output)
            : (session.files[fp] && session.files[fp].estTokens) || 0;
        } else if (toolName === 'Grep' || toolName === 'Glob') {
          tokensAdded = 200; // result listings are small but not free
        }
        if (updateExploreStreak(session, toolName, tokensAdded)) {
          const e = session.explore;
          emitNotice(sessionId, {
            kind: 'delegate',
            text: `[kco] ${e.streak} read/search calls in a row, no edits (~${formatTokens(e.streakTokens)} tokens now pinned in main context). ` +
              `Broad exploration is cheaper in a subagent (Agent/AgentSwarm, e.g. subagent_type "explore"): its context is discarded, only the conclusion returns.`,
          });
        }
      }

      // ── Live session mini-stats (every 15 tool calls) ──
      if (session.totalToolCalls > 0 && session.totalToolCalls % 15 === 0) {
        try {
          const cacheFile = join(DATA_DIR, 'read-cache', `${sessionId}.json`);
          const cache = loadJSON(cacheFile);
          if (cache && cache.totalTokensSaved > 0) {
            const totalTracked = Object.values(session.files)
              .reduce((sum, f) => sum + (f.estTokens || 0), 0);
            const saved = cache.totalTokensSaved;
            const total = totalTracked + saved;
            const pct = total > 0 ? Math.round((saved / total) * 100) : 0;
            if (pct > 0) {
              // Routed through the notice ledger so the pulse respects the
              // session noise cap and its tokens count as overhead (NET math).
              emitNotice(sessionId, {
                kind: 'pulse',
                text: `[kco] Session pulse: ${formatTokens(totalTracked)} used, ` +
                  `${formatTokens(saved)} saved by KCO (${pct}% efficiency)`,
              });
            }
          }
        } catch { /* don't block on stats failure */ }
      }

      break;
    }

    case 'PostToolUseFailure': {
      // KCO addition: Kimi fires this on blocked/failed calls with
      // error: { code, message, retryable }. Count failures per tool and,
      // after 3+ of the same tool, emit ONE usage advisory per session.
      trackToolUse(session, toolName);
      const advisory = trackFailure(session, toolName, event.error);
      if (advisory) {
        emitNotice(sessionId, { kind: `failure:${toolName}`, text: advisory });
      }
      break;
    }

    case 'SubagentStart':
    case 'SubagentStop': {
      // KCO addition: record delegation directly from Kimi's subagent events
      // (replaces the unreliable PPID heuristic, which stays as a fallback in
      // read-cache). SubagentStop counts once per completed delegation.
      if (hookEvent === 'SubagentStop') {
        session.delegations = (session.delegations || 0) + 1;
      }
      const name = event.subagent_type || toolInput.subagent_type || event.matcher || '';
      if (name && !session.subagents) session.subagents = [];
      if (name && !session.subagents.includes(name)) {
        session.subagents.push(name);
        if (session.subagents.length > 20) session.subagents.splice(0, session.subagents.length - 20);
      }
      break;
    }

    case 'SessionStart': {
      // ── AGENTS.md size nudge ──
      // Memory files load into EVERY prompt of every session — the most
      // expensive place for bloat. Community guidance: keep under 200 lines.
      try {
        const memoryFiles = [
          join(event.cwd || process.cwd(), 'AGENTS.md'),
          join(homedir(), '.agents', 'AGENTS.md'),
        ];
        let memLines = 0;
        for (const f of memoryFiles) {
          if (existsSync(f)) memLines += readFileSync(f, 'utf-8').split('\n').length;
        }
        if (memLines > 200) {
          emitNotice(sessionId, {
            kind: 'agentsmd-size',
            text:
              `[kco] AGENTS.md memory totals ${memLines} lines — it loads into every prompt ` +
              `(≤200 recommended). Run /kco-agentsmd to find what to trim or split into per-directory AGENTS.md files.`,
          });
        }
      } catch { /* never block session start */ }

      try {
        const globalStats = loadGlobalStats();
        if (globalStats.totalSessions >= 3) {
          // Weekly savings streak
          const savings = calculateWeeklySavings(globalStats);
          if (savings && savings.sessions >= 3) {
            if (savings.improving) {
              advise(`[kco] Waste down ${savings.improvementPct}% this week — you're getting better!`);
            } else if (savings.avgWaste > 30) {
              advise(`[kco] ${savings.avgWaste}% avg waste this week (${savings.sessions} sessions). Tip: Grep before Read saves tokens!`);
            }
          }

          // Warn about known waste files for current project
          const patterns = loadPatterns();
          const cwd = event.cwd || process.cwd();
          for (const [projKey, proj] of Object.entries(patterns.projects)) {
            if (projKey === '_global' || cwd.startsWith(projKey)) {
              const topWaste = Object.entries(proj.wastedReads || {})
                .filter(([, d]) => d.sessions >= 3)
                .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted)
                .slice(0, 2);
              if (topWaste.length > 0) {
                const names = topWaste.map(([p]) => basename(p)).join(', ');
                advise(`[kco] Often unused: ${names}. You can probably skip these.`);
              }
              // Mention auto-template if available
              const projectName = basename(projKey);
              const templateFile = join(TEMPLATES_DIR, `auto-${projectName}.json`);
              if (existsSync(templateFile)) {
                advise(`[kco] Auto-template ready! Run: /kco-templates apply auto-${projectName}`);
              }
              break;
            }
          }
        }
      } catch { /* don't block session start */ }
      break;
    }

    case 'PreCompact': {
      session.compactions++;
      break;
    }

    case 'SessionEnd': {
      const result = finalizeSession(session);
      if (result.sessionTokensTotal > 0) {
        const wastePercent = Math.round((result.sessionTokensWasted / result.sessionTokensTotal) * 100);
        let msg = `[kco] Session: ~${formatTokens(result.sessionTokensTotal)} tracked, ` +
          `~${formatTokens(result.sessionTokensWasted)} wasted (${wastePercent}%). ` +
          `${Object.keys(session.files).length} files, ${session.totalEdits} edits.`;

        // Compare with recent average
        const globalStats = loadGlobalStats();
        const recent = globalStats.sessionHistory.slice(-6, -1).filter(s => s.tokensTotal > 0);
        if (recent.length >= 3) {
          const recentAvg = recent.reduce((s, x) => s + x.wastePercent, 0) / recent.length;
          if (wastePercent < recentAvg - 5) {
            msg += ` Better than avg (${Math.round(recentAvg)}%)!`;
          } else if (wastePercent > recentAvg + 10) {
            msg += ` Above avg (${Math.round(recentAvg)}%) — check /kco for details.`;
          }
        }

        advise(msg);
      }

      // Generate session summary for replay
      const summary = generateSessionSummary(session);
      if (summary) {
        const summaryFile = join(SUMMARIES_DIR, `${session.id}.txt`);
        writeFileSync(summaryFile, summary, 'utf-8');
      }

      // ── Self-calibration from wire.jsonl ground truth ──
      // The wire transcript carries exact per-step usage — compare it against
      // what the chars-per-token heuristic THOUGHT the session cost and EMA
      // the drift into config. Estimates get more honest by themselves.
      try {
        const usage = getSessionUsage(sessionId, event.cwd || process.cwd());
        const estimated = Object.values(session.files)
          .reduce((sum, f) => sum + (f.estTokens || 0) * (f.reads || 0), 0);
        if (usage.contextTokens > 0 && estimated > 0) {
          updateCalibrationFromSession(usage.contextTokens, estimated);
        }
      } catch { /* calibration is best-effort */ }
      break;
    }

    default:
      break;
  }

  saveSession(session);
}

// ── Main entry ──────────────────────────────────────────────────────────────
// runHook() reads the stdin payload and passes it here (fail-open wrapper).
async function main(payload) {
  await handleHookEvent(payload || {});
}

// CLI actions (report/heatmap/suggest) run without touching stdin; hook mode
// (no action) goes through runHook, which owns stdin + exit codes.
function cliMain() {
  const action = process.argv[2];

  if (action === 'report') {
    if (!existsSync(GLOBAL_STATS_FILE)) rebuildGlobalStats();
    console.log(JSON.stringify(loadGlobalStats(), null, 2));
    return;
  }

  if (action === 'patterns') {
    console.log(JSON.stringify(loadPatterns(), null, 2));
    return;
  }

  if (action === 'session-report') {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error('Usage: tracker session-report <session-id>'); process.exit(1); }
    console.log(JSON.stringify(loadSession(sessionId), null, 2));
    return;
  }

  if (action === 'heatmap') {
    let sessionId = process.argv[3];
    if (!sessionId) {
      const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      if (sessionFiles.length === 0) { console.log('No sessions tracked yet.'); return; }
      const sorted = sessionFiles
        .map(f => ({ name: f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      sessionId = sorted[0].name.replace('.json', '');
    }
    console.log(generateHeatmap(loadSession(sessionId)));
    return;
  }

  if (action === 'suggest') {
    const cwd = process.argv[3] || process.cwd();
    console.log(JSON.stringify(generateSuggestions(cwd), null, 2));
    return;
  }

  runHook(main);
}

if (isMainModule(import.meta.url)) {
  cliMain();
}

// Exposed for tests
export { trackSearch, trackToolUse, handleHookEvent, loadSession };
// (updateExploreStreak and trackFailure are exported at their definitions)
