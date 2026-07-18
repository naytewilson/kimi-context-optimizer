#!/usr/bin/env node

/**
 * AGENTS.md Analyzer v1.0 (KCO — Kimi Code port)
 *
 * Analyzes AGENTS.md files for token bloat and suggests optimizations.
 * Detects: duplicate content, verbose sections, boilerplate, oversized rules.
 *
 * Targets (vs the original's CLAUDE.md / .claude/CLAUDE.md):
 *   - ./AGENTS.md (and up to 5 parent dirs) — project-level instructions
 *   - ~/.agents/AGENTS.md — user-level shared instructions (Kimi)
 *
 * Used by the /kco-agentsmd skill. Pure analysis is exported for tests.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  estimateTokens, formatTokens, computeCost, formatCost, isMainModule
} from './utils.js';

/** User-level shared instructions (Kimi's equivalent of ~/.claude/CLAUDE.md). */
export function userAgentsFile() {
  return join(homedir(), '.agents', 'AGENTS.md');
}

/**
 * All AGENTS.md files that load into context for a session rooted at cwd:
 * project-level (cwd + up to 5 parents) and the user-level ~/.agents/AGENTS.md.
 */
export function findAgentsFiles(cwd) {
  const candidates = [join(cwd, 'AGENTS.md')];

  // Check parent directories for project-level AGENTS.md
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'AGENTS.md');
    if (!candidates.includes(candidate)) candidates.push(candidate);
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // User-level shared instructions
  const userFile = userAgentsFile();
  if (!candidates.includes(userFile)) candidates.push(userFile);

  return candidates.filter(f => existsSync(f));
}

export function analyzeContent(content, filePath) {
  const lines = content.split('\n');
  const tokens = estimateTokens(lines.length, '.md');
  const issues = [];
  const sections = [];

  // Parse sections
  let currentSection = { title: '(top)', startLine: 0, lines: [], tokens: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) {
      if (currentSection.lines.length > 0) {
        currentSection.tokens = estimateTokens(currentSection.lines.length, '.md');
        sections.push(currentSection);
      }
      currentSection = { title: line.replace(/^#+\s*/, ''), startLine: i + 1, lines: [], tokens: 0 };
    }
    currentSection.lines.push(line);
  }
  currentSection.tokens = estimateTokens(currentSection.lines.length, '.md');
  sections.push(currentSection);

  // ── Check 1: Overall size ──
  if (tokens > 5000) {
    issues.push({
      severity: 'high',
      type: 'size',
      message: `File is ${formatTokens(tokens)} tokens — consider splitting into focused sections`,
      savings: Math.round(tokens * 0.3)
    });
  } else if (tokens > 2000) {
    issues.push({
      severity: 'medium',
      type: 'size',
      message: `File is ${formatTokens(tokens)} tokens — review for unnecessary content`,
      savings: Math.round(tokens * 0.15)
    });
  }

  // ── Check 2: Large sections ──
  for (const section of sections) {
    if (section.tokens > 1000) {
      issues.push({
        severity: 'medium',
        type: 'section_size',
        message: `Section "${section.title}" is ${formatTokens(section.tokens)} tokens (line ${section.startLine})`,
        savings: Math.round(section.tokens * 0.3)
      });
    }
  }

  // ── Check 3: Duplicate or near-duplicate lines ──
  const lineMap = {};
  const duplicates = [];
  for (let i = 0; i < lines.length; i++) {
    const normalized = lines[i].trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length < 10) continue; // skip short lines
    if (lineMap[normalized] !== undefined) {
      duplicates.push({ line: i + 1, text: lines[i].trim(), firstAt: lineMap[normalized] + 1 });
    } else {
      lineMap[normalized] = i;
    }
  }
  if (duplicates.length > 0) {
    issues.push({
      severity: 'high',
      type: 'duplicates',
      message: `${duplicates.length} duplicate line(s) found`,
      details: duplicates.slice(0, 5).map(d => `  Line ${d.line}: "${d.text.substring(0, 60)}..." (same as line ${d.firstAt})`),
      savings: estimateTokens(duplicates.length, '.md')
    });
  }

  // ── Check 4: Verbose patterns ──
  const verbosePatterns = [
    { regex: /please\s+make\s+sure\s+to/gi, fix: 'Use imperative: "Always X" instead of "Please make sure to X"' },
    { regex: /it\s+is\s+important\s+that/gi, fix: 'Remove filler. Just state the rule directly.' },
    { regex: /you\s+should\s+always/gi, fix: 'Simplify to: "Always X"' },
    { regex: /do\s+not\s+under\s+any\s+circumstances/gi, fix: 'Simplify to: "Never X"' },
    { regex: /when\s+you\s+are\s+working\s+on/gi, fix: 'Simplify to: "For X tasks:"' },
  ];

  for (const { regex, fix } of verbosePatterns) {
    const matches = content.match(regex);
    if (matches) {
      issues.push({
        severity: 'low',
        type: 'verbose',
        message: `"${matches[0]}" found ${matches.length}x — ${fix}`,
        savings: matches.length * 3
      });
    }
  }

  // ── Check 5: Long examples/code blocks ──
  let inCodeBlock = false;
  let codeBlockStart = 0;
  let codeBlockLines = 0;
  let totalCodeLines = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      if (inCodeBlock) {
        if (codeBlockLines > 20) {
          issues.push({
            severity: 'medium',
            type: 'code_block',
            message: `Code block at line ${codeBlockStart + 1} is ${codeBlockLines} lines — consider shortening or referencing a file`,
            savings: estimateTokens(Math.max(0, codeBlockLines - 10), '.md')
          });
        }
        totalCodeLines += codeBlockLines;
        inCodeBlock = false;
        codeBlockLines = 0;
      } else {
        inCodeBlock = true;
        codeBlockStart = i;
        codeBlockLines = 0;
      }
    } else if (inCodeBlock) {
      codeBlockLines++;
    }
  }

  if (totalCodeLines > lines.length * 0.4) {
    issues.push({
      severity: 'medium',
      type: 'code_heavy',
      message: `${Math.round((totalCodeLines / lines.length) * 100)}% of content is code blocks — consider moving examples to separate files`,
      savings: estimateTokens(Math.round(totalCodeLines * 0.5), '.md')
    });
  }

  // ── Check 6: Empty/comment-only lines ratio ──
  const emptyLines = lines.filter(l => l.trim() === '' || l.trim() === '---').length;
  if (emptyLines > lines.length * 0.3) {
    issues.push({
      severity: 'low',
      type: 'whitespace',
      message: `${Math.round((emptyLines / lines.length) * 100)}% empty/separator lines — reduce for token savings`,
      savings: estimateTokens(Math.round(emptyLines * 0.5), '.md')
    });
  }

  const totalSavings = issues.reduce((sum, i) => sum + (i.savings || 0), 0);

  return { filePath, tokens, lines: lines.length, sections, issues, totalSavings };
}

export function formatReport(analysis) {
  let output = '\n';
  output += `  AGENTS.MD ANALYSIS\n`;
  output += `  ${'═'.repeat(62)}\n`;
  output += `  File: ${analysis.filePath}\n`;
  output += `  Size: ${analysis.lines} lines | ~${formatTokens(analysis.tokens)} tokens\n`;
  output += `  Sections: ${analysis.sections.length}\n`;
  output += `  ${'─'.repeat(62)}\n\n`;

  // Section breakdown
  output += `  SECTIONS\n`;
  output += `  ${'─'.repeat(62)}\n`;
  for (const section of analysis.sections) {
    const bar = '█'.repeat(Math.max(1, Math.round((section.tokens / analysis.tokens) * 30)));
    output += `  ${formatTokens(section.tokens).padStart(6)} ${bar} ${section.title}\n`;
  }
  output += '\n';

  if (analysis.issues.length === 0) {
    output += `  ✓ Looking good! Your AGENTS.md is clean and efficient.\n`;
  } else {
    output += `  ISSUES (${analysis.issues.length})\n`;
    output += `  ${'─'.repeat(62)}\n`;

    const severity = { high: '⚠', medium: '●', low: '○' };
    for (const issue of analysis.issues.sort((a, b) => (b.savings || 0) - (a.savings || 0))) {
      output += `  ${severity[issue.severity] || '·'} ${issue.message}`;
      if (issue.savings > 0) {
        output += ` (~${formatTokens(issue.savings)} saveable)`;
      }
      output += '\n';
      if (issue.details) {
        for (const d of issue.details) {
          output += `    ${d}\n`;
        }
      }
    }

    output += `\n  ${'─'.repeat(62)}\n`;
    output += `  POTENTIAL SAVINGS: ~${formatTokens(analysis.totalSavings)} tokens\n`;
    // Tokens-first: $ only when the user configured pricing (Kimi is a
    // subscription — cost is opt-in via config.json).
    const cost = formatCost(computeCost(analysis.totalSavings, 'input'));
    if (cost) {
      output += `  That's ~${cost}/session at your configured input price\n`;
    }
    output += `  Apply the fixes, then re-run /kco-agentsmd to verify.\n`;
  }

  output += '\n';
  return output;
}

// ── Main ──

function main() {
  const cwd = process.argv[2] || process.cwd();
  const files = findAgentsFiles(cwd);

  if (files.length === 0) {
    console.log('No AGENTS.md found. Create one to give Kimi project context — then keep it lean with /kco-agentsmd.');
    return;
  }

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const analysis = analyzeContent(content, filePath);
      console.log(formatReport(analysis));
    } catch (err) {
      console.error(`[kco] Error analyzing ${filePath}: ${err.message}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch { process.exit(0); } // fail-open
}
