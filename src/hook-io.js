/**
 * Hook protocol helpers for Kimi Code hooks.
 *
 * Kimi's hook/tool surface changed after the July 2026 live capture this fork
 * was originally ported from. Current Kimi source uses ReadFile/WriteFile/
 * StrReplaceFile/Shell. ReadFile uses path + line_offset/n_lines and current
 * StrReplaceFile uses path + edit:{old,new,replace_all} (or an edit array).
 * Older captures used Read/Edit/Write/Bash with path + offset/limit and flat
 * old/new fields. KCO normalizes both generations at one boundary.
 */

import { isAbsolute, resolve } from 'node:path';
import { isMainModule } from './utils.js';

export function readPayload() {
  return new Promise((resolvePayload) => {
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!raw.trim()) return resolvePayload({});
      try { resolvePayload(JSON.parse(raw)); }
      catch { resolvePayload({}); }
    };
    const timer = setTimeout(done, 25_000);
    timer.unref?.();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
  });
}

export function block(reason) {
  console.error(reason);
  process.exit(2);
}

export function advise(text) {
  process.stdout.write(String(text) + '\n');
}

const TOOL_ALIASES = Object.freeze({
  ReadFile: 'Read',
  Read: 'Read',
  WriteFile: 'Write',
  Write: 'Write',
  StrReplaceFile: 'Edit',
  Edit: 'Edit',
  Shell: 'Bash',
  Bash: 'Bash',
});

export function canonicalToolName(name) {
  return TOOL_ALIASES[name] || name || '';
}

export function getToolPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const p = toolInput.path ?? toolInput.file_path;
  return typeof p === 'string' ? p : '';
}

/**
 * Normalize current ReadFile line_offset/n_lines and legacy offset/limit to a
 * zero-based requested [offset,end) range.
 *
 * Positive offsets are deliberately NOT clamped to EOF. An out-of-range request
 * must remain distinguishable from an already-covered range so KCO does not
 * intercept a tool call that Kimi itself should answer/error. totalLines is
 * used only to resolve negative line_offset and to shrink an in-file request
 * to the amount that can actually be returned.
 */
export function getReadRange(toolInput = {}, totalLines = 0) {
  const hasCurrentOffset = Number.isFinite(toolInput.line_offset);
  const hasLegacyOffset = Number.isFinite(toolInput.offset);
  let offset = 0;

  if (hasCurrentOffset) {
    const raw = Math.trunc(toolInput.line_offset);
    if (raw < 0 && totalLines > 0) offset = Math.max(0, totalLines + raw);
    else if (raw > 0) offset = raw - 1;
  } else if (hasLegacyOffset) {
    offset = Math.max(0, Math.trunc(toolInput.offset));
  }

  let limit;
  if (Number.isFinite(toolInput.n_lines)) limit = Math.max(0, Math.trunc(toolInput.n_lines));
  else if (Number.isFinite(toolInput.limit)) limit = Math.max(0, Math.trunc(toolInput.limit));
  else limit = 1000;

  if (totalLines > 0 && offset < totalLines) {
    limit = Math.min(limit, Math.max(0, totalLines - offset));
  }

  return { offset, limit, end: offset + limit };
}

function flattenEdits(edit) {
  const edits = Array.isArray(edit) ? edit : (edit && typeof edit === 'object' ? [edit] : []);
  return edits.filter((item) => item && typeof item === 'object');
}

/**
 * Normalize a hook payload for legacy KCO core modules without discarding the
 * original tool name or current fields. This is intentionally additive.
 *
 * For StrReplaceFile, flat old_string/new_string are synthesized only for
 * token-size estimation. The real nested edit object remains intact.
 */
export function normalizeHookPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return {};

  const originalToolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolName = canonicalToolName(originalToolName);
  const sourceInput = payload.tool_input && typeof payload.tool_input === 'object'
    ? payload.tool_input : {};
  const toolInput = { ...sourceInput };

  const path = getToolPath(sourceInput);
  if (path) {
    if (typeof toolInput.path !== 'string') toolInput.path = path;
    if (typeof toolInput.file_path !== 'string') toolInput.file_path = path;
  }

  if (toolName === 'Read') {
    // Preserve current fields while synthesizing the older zero-based shape.
    // Negative current offsets cannot be converted without the file length, so
    // leave `offset` unset in that case; read-cache resolves them with disk truth.
    if (!Number.isFinite(toolInput.offset) && Number.isFinite(sourceInput.line_offset)) {
      const raw = Math.trunc(sourceInput.line_offset);
      if (raw > 0) toolInput.offset = raw - 1;
    }
    if (!Number.isFinite(toolInput.limit) && Number.isFinite(sourceInput.n_lines)) {
      toolInput.limit = Math.max(0, Math.trunc(sourceInput.n_lines));
    }
  }

  if (toolName === 'Edit') {
    const edits = flattenEdits(sourceInput.edit);
    if (edits.length) {
      if (typeof toolInput.old_string !== 'string') {
        toolInput.old_string = edits.map((e) => typeof e.old === 'string' ? e.old : '').join('\n');
      }
      if (typeof toolInput.new_string !== 'string') {
        toolInput.new_string = edits.map((e) => typeof e.new === 'string' ? e.new : '').join('\n');
      }
    } else {
      // Defensive support for recent/alternate flat spellings.
      if (typeof toolInput.old_string !== 'string' && typeof sourceInput.old_str === 'string') {
        toolInput.old_string = sourceInput.old_str;
      }
      if (typeof toolInput.new_string !== 'string' && typeof sourceInput.new_str === 'string') {
        toolInput.new_string = sourceInput.new_str;
      }
    }
  }

  return {
    ...payload,
    tool_name: toolName,
    tool_input: toolInput,
    kco_original_tool_name: originalToolName || toolName,
  };
}

export function resolvePayloadPath(payload, p) {
  if (!p || typeof p !== 'string') return '';
  if (isAbsolute(p)) return p;
  const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  return resolve(cwd, p);
}

export function getPromptText(payload) {
  const p = payload && payload.prompt;
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) {
    return p
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export { isMainModule };

export async function runHook(main) {
  try {
    const payload = await readPayload();
    await main(payload);
    process.exit(0);
  } catch {
    process.exit(0);
  }
}
