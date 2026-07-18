#!/usr/bin/env node
// Dev diagnostic: capture raw hook payloads from Kimi Code CLI.
// Registers nothing by itself — wire it in config.toml like:
//   [[hooks]]
//   event = "PostToolUse"
//   command = "node /path/to/hooks/capture-payload.mjs"
// Every payload is appended as one JSON line to hooks/payloads.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outFile = join(dirname(fileURLToPath(import.meta.url)), 'payloads.jsonl');

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    // Truncate bulky values so the log stays readable, but record sizes.
    const summary = { _capturedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.length > 500) {
        summary[k] = { _truncated: true, length: v.length, head: v.slice(0, 200) };
      } else if (v && typeof v === 'object') {
        summary[k] = { _type: Array.isArray(v) ? 'array' : 'object', keys: Object.keys(v).slice(0, 30) };
        // keep small scalar fields of one level
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === 'string' && v2.length > 500) {
            summary[k][k2] = { _truncated: true, length: v2.length, head: v2.slice(0, 200) };
          } else if (typeof v2 !== 'object') {
            summary[k][k2] = v2;
          }
        }
      } else {
        summary[k] = v;
      }
    }
    mkdirSync(dirname(outFile), { recursive: true });
    appendFileSync(outFile, JSON.stringify(summary) + '\n');
  } catch (e) {
    appendFileSync(outFile, JSON.stringify({ _error: String(e), _raw: input.slice(0, 500) }) + '\n');
  }
  process.exit(0);
});
