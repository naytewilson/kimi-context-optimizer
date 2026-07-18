#!/usr/bin/env node

/**
 * Sync version from package.json (single source of truth) into the Kimi
 * plugin manifest:
 *   - kimi.plugin.json  (version only — the manifest's description is its
 *     own user-facing copy, not a mirror of package.json)
 *
 * Run before publish: npm run sync-version
 *
 * An optional root dir argument makes the script testable against fixtures:
 *   node scripts/sync-version.js [rootDir]
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

const manifestPath = join(ROOT, 'kimi.plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

if (manifest.version === pkg.version) {
  console.log(`✓ versions already in sync: ${pkg.version}`);
} else {
  const before = manifest.version;
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ kimi.plugin.json: ${before} → ${pkg.version}`);
}
