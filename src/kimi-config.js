/**
 * Reader for the Kimi Code CLI config (~/.kimi-code/config.toml) — zero deps.
 *
 * The CLI config is the source of truth for the active model and its context
 * window:
 *   default_model = "kimi-code/k3"
 *   [models."kimi-code/k3"]
 *   model = "k3"
 *   max_context_size = 1048576
 *   display_name = "K3"
 *
 * Parsing is regex-based (no TOML dependency) and tolerant: missing keys fall
 * back to defaults. KCO_CONTEXT_WINDOW (integer) overrides the context window
 * from any source.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const DEFAULT_CONTEXT_WINDOW = 262144;

/** Kimi Code home dir (config, sessions, logs). Env override for tests. */
export function getKimiHome() {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

// ── Minimal TOML helpers (flat keys + [section] headers only) ────────────────

/** Parse a `key = value` line — string, integer, or boolean. Null if not one. */
function parseKV(line) {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
  if (!m) return null;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) return [m[1], v.slice(1, -1)];
  if (v.startsWith("'") && v.endsWith("'")) return [m[1], v.slice(1, -1)];
  if (/^-?\d+$/.test(v)) return [m[1], parseInt(v, 10)];
  if (v === 'true') return [m[1], true];
  if (v === 'false') return [m[1], false];
  return null;
}

/**
 * Extract the body of a `[models."<alias>"]` section (aliases may contain
 * slashes and dots). Returns the section's text or null when absent.
 */
function findModelSection(toml, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\[models\\."${escaped}"\\][^\\S\\n]*$`, 'm');
  const m = toml.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = toml.slice(start);
  const nextSection = rest.search(/^\[/m);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

/** Read a flat top-level key from TOML text (before any section header). */
function topLevelValue(toml, key) {
  const head = toml.split(/^\[/m)[0];
  for (const line of head.split('\n')) {
    const kv = parseKV(line);
    if (kv && kv[0] === key) return kv[1];
  }
  return null;
}

/** Read a key from a TOML section body. */
function sectionValue(sectionText, key) {
  if (!sectionText) return null;
  for (const line of sectionText.split('\n')) {
    const kv = parseKV(line);
    if (kv && kv[0] === key) return kv[1];
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * The active model as configured in ~/.kimi-code/config.toml.
 * Returns { alias, model, displayName, maxContextSize }:
 *   - alias          — default_model value (e.g. "kimi-code/k3"), null if unset
 *   - model          — the section's `model` (e.g. "k3"), falls back to alias
 *   - displayName    — the section's `display_name` (e.g. "K3"), null if unset
 *   - maxContextSize — the section's `max_context_size`, default 262144;
 *                      KCO_CONTEXT_WINDOW (integer) wins over everything.
 * Never throws — a missing/unreadable config yields all defaults.
 */
export function getActiveModel() {
  let alias = null;
  let model = null;
  let displayName = null;
  let maxContextSize = DEFAULT_CONTEXT_WINDOW;

  try {
    const toml = readFileSync(join(getKimiHome(), 'config.toml'), 'utf-8');
    const def = topLevelValue(toml, 'default_model');
    if (typeof def === 'string' && def) {
      alias = def;
      const section = findModelSection(toml, alias);
      const sectionModel = sectionValue(section, 'model');
      const sectionName = sectionValue(section, 'display_name');
      const sectionWindow = sectionValue(section, 'max_context_size');
      if (typeof sectionModel === 'string' && sectionModel) model = sectionModel;
      if (typeof sectionName === 'string' && sectionName) displayName = sectionName;
      if (typeof sectionWindow === 'number' && sectionWindow > 0) maxContextSize = sectionWindow;
    }
  } catch { /* config missing or unreadable — all defaults */ }

  if (!model && alias) model = alias;

  const envWindow = parseInt(process.env.KCO_CONTEXT_WINDOW || '', 10);
  if (Number.isInteger(envWindow) && envWindow > 0) maxContextSize = envWindow;

  return { alias, model, displayName, maxContextSize };
}
