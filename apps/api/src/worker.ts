import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { JsonStore } from './domain/store.js';
import { drainOutbox } from './domain/service.js';

const filePath = process.env.CAMPMIND_DATA_FILE ?? resolve(process.cwd(), 'private-data/demo-store.json');
if (process.env.NODE_ENV === 'production' && !process.env.CAMPMIND_MASTER_KEY) {
  throw new Error('CAMPMIND_MASTER_KEY must be configured in production');
}
if (!existsSync(filePath)) {
  console.error(`Data file does not exist: ${filePath}`);
  process.exitCode = 1;
} else {
  const store = new JsonStore({ filePath });
  const result = await drainOutbox(store, Number(process.env.CAMPMIND_WORKER_LIMIT ?? 100));
  console.log(JSON.stringify({ service: 'campus-mind-worker', ...result }));
}
