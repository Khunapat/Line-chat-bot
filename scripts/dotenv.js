import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load KEY=value lines from the project's .env into process.env without
 * overriding variables that are already set. Enough for these helper scripts;
 * the server itself gets its variables from Cloud Run.
 */
export function loadDotEnv(file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || m[1] in process.env) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
