import path from 'node:path';
import { loadDotEnv, APP_DIR } from './lib/env.js';
import { createApp } from './lib/app.js';
import { createProvider } from './lib/providers.js';
import { createStore } from './lib/store.js';

loadDotEnv();

const env = process.env;
const port = env.PORT ? Number(env.PORT) : 8090;
const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(APP_DIR, 'data');
const explainLang = String(env.EXPLAIN_LANG || 'en').toLowerCase() === 'th' ? 'th' : 'en';

const provider = createProvider(env);
const app = createApp({
  provider,
  store: createStore(dataDir),
  password: env.APP_PASSWORD || '',
  explainLang,
});

const server = app.listen(port, () => {
  const mode = provider.name === 'mock' ? 'mock (demo mode)' : provider.name;
  console.log(`Speaking partner on http://localhost:${server.address().port}  provider: ${mode}  data: ${dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
