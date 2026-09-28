import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load KEY=value lines from speaking-app/.env into `env` without overriding
 * variables that are already set. Missing file is fine.
 */
export function loadDotEnv(file = path.join(APP_DIR, '.env'), env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || m[1] in env) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
}
