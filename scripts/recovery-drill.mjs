import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState } from '../dist/apps/api/src/domain/seed.js';

// Local-only synthetic recovery drill. It does not exercise a production backup provider.
const directory = mkdtempSync(join(tmpdir(), 'campus-mind-recovery-'));
const sourcePath = join(directory, 'source.json');
const backupPath = join(directory, 'backup.json');
const source = new JsonStore({ filePath: sourcePath, initial: seedDemoState() });
const backupSnapshot = source.snapshot();
copyFileSync(sourcePath, backupPath);

await source.transaction((state) => {
  state.auditEvents.push({ id: 'synthetic-after-backup', tenantId: 'tenant-demo', action: 'drill.only', objectType: 'drill', objectId: 'synthetic-after-backup', metadata: {}, createdAt: new Date().toISOString() });
});

const restored = new JsonStore({ filePath: backupPath });
const restoredSnapshot = restored.snapshot();
assert.equal(restoredSnapshot.schemaVersion, backupSnapshot.schemaVersion);
assert.equal(restoredSnapshot.students.length, backupSnapshot.students.length);
assert.equal(restoredSnapshot.auditEvents.some((event) => event.id === 'synthetic-after-backup'), false);
assert.ok(Array.isArray(restoredSnapshot.outboxEvents));
assert.ok(Array.isArray(restoredSnapshot.mediaAssets));
console.log(JSON.stringify({ status: 'ok', scope: 'synthetic-local-json', students: restoredSnapshot.students.length, directory }));
