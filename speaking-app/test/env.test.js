import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv } from '../lib/env.js';

test('loadDotEnv reads KEY=value without overriding existing vars', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speaking-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, '# comment\nA=1\nB="two words"\nC=\'x=y\'\nexport D=4\nKEEP=new\nnot a line\n');
  const env = { KEEP: 'old' };
  loadDotEnv(file, env);
  assert.deepEqual(env, { KEEP: 'old', A: '1', B: 'two words', C: 'x=y', D: '4' });
  loadDotEnv(path.join(dir, 'missing'), env); // no throw
});
