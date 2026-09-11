import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { assertProductionStoreInjection, JsonStore } from './domain/store.js';
import { drainOutbox } from './domain/service.js';
import { assertProductionConfig } from './domain/crypto.js';
import { EncryptedFileObjectStore } from './infra/object-store.js';

const filePath = process.env.CAMPMIND_DATA_FILE ?? resolve(process.cwd(), 'private-data/demo-store.json');
const objectRoot = process.env.CAMPMIND_OBJECTS_DIR ?? resolve(process.cwd(), 'private-data/objects');
assertProductionConfig();
assertProductionStoreInjection();
if (!existsSync(filePath)) {
  console.error(`Data file does not exist: ${filePath}`);
  process.exitCode = 1;
} else {
  const store = new JsonStore({ filePath, objectStore: new EncryptedFileObjectStore({ rootDir: objectRoot }) });
  const result = await drainOutbox(store, Number(process.env.CAMPMIND_WORKER_LIMIT ?? 100));
  console.log(JSON.stringify({ service: 'campus-mind-worker', ...result }));
}
