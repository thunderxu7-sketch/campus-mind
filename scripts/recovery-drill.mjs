import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState } from '../dist/apps/api/src/domain/seed.js';
import { EncryptedFileObjectStore } from '../dist/apps/api/src/infra/object-store.js';

// Local-only synthetic recovery drill. It does not exercise a production backup provider.
const directory = mkdtempSync(join(tmpdir(), 'campus-mind-recovery-'));
const sourcePath = join(directory, 'source.json');
const backupPath = join(directory, 'backup.json');
const sourceObjectDir = join(directory, 'source-objects');
const backupObjectDir = join(directory, 'backup-objects');
const sourceObjectStore = new EncryptedFileObjectStore({ rootDir: sourceObjectDir });
const source = new JsonStore({ filePath: sourcePath, initial: seedDemoState(), objectStore: sourceObjectStore });
await sourceObjectStore.put({ tenantId: 'tenant-demo', objectKey: 'media/tenant-demo/recovery-object', contentType: 'application/octet-stream', bytes: Buffer.from('synthetic recovery object') });
const backupSnapshot = source.snapshot();
copyFileSync(sourcePath, backupPath);
cpSync(sourceObjectDir, backupObjectDir, { recursive: true });

await source.transaction((state) => {
  state.auditEvents.push({ id: 'synthetic-after-backup', tenantId: 'tenant-demo', action: 'drill.only', objectType: 'drill', objectId: 'synthetic-after-backup', metadata: {}, createdAt: new Date().toISOString() });
});

const restoredObjectStore = new EncryptedFileObjectStore({ rootDir: backupObjectDir });
const restored = new JsonStore({ filePath: backupPath, objectStore: restoredObjectStore });
const restoredSnapshot = restored.snapshot();
assert.equal(restoredSnapshot.schemaVersion, backupSnapshot.schemaVersion);
assert.equal(restoredSnapshot.students.length, backupSnapshot.students.length);
assert.equal(restoredSnapshot.auditEvents.some((event) => event.id === 'synthetic-after-backup'), false);
assert.ok(Array.isArray(restoredSnapshot.outboxEvents));
assert.ok(Array.isArray(restoredSnapshot.mediaAssets));
const restoredObject = await restoredObjectStore.get({ tenantId: 'tenant-demo', objectKey: 'media/tenant-demo/recovery-object' });
assert.equal(restoredObject.bytes.toString('utf8'), 'synthetic recovery object');
console.log(JSON.stringify({ status: 'ok', scope: 'synthetic-local-json-and-encrypted-object-store', students: restoredSnapshot.students.length, objects: 1, directory }));
