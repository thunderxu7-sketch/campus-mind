import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt, reencrypt } from '../dist/apps/api/src/domain/crypto.js';
import { EncryptedFileObjectStore } from '../dist/apps/api/src/infra/object-store.js';

// Synthetic-only drill. Production rotations must run through the approved
// secret manager/KMS job with an operator, coverage and rollback record.
const oldKey = 'old-key-rotation-drill-dedicated-2026-abcdef';
const newKey = 'new-key-rotation-drill-dedicated-2026-abcdef';
const previousNodeEnv = process.env.NODE_ENV;
const previousCurrent = process.env.CAMPMIND_MASTER_KEY;
const previousKeys = process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
const root = mkdtempSync(join(tmpdir(), 'campus-mind-key-rotation-'));

try {
  process.env.NODE_ENV = 'test';
  process.env.CAMPMIND_MASTER_KEY = oldKey;
  delete process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
  const fieldEnvelope = encrypt({ marker: 'synthetic-field' });
  const objectStore = new EncryptedFileObjectStore({ rootDir: root, maxBytes: 1024 });
  const objectInput = { tenantId: 'tenant-rotation', objectKey: 'media/tenant-rotation/item', contentType: 'image/png', bytes: Buffer.from('synthetic-object') };
  await objectStore.put(objectInput);

  process.env.CAMPMIND_MASTER_KEY = newKey;
  process.env.CAMPMIND_PREVIOUS_MASTER_KEYS = oldKey;
  assert.deepEqual(decrypt(fieldEnvelope), { marker: 'synthetic-field' });
  const rotatedField = reencrypt(fieldEnvelope);
  await objectStore.reencrypt(objectInput);
  assert.deepEqual(decrypt(rotatedField), { marker: 'synthetic-field' });
  assert.deepEqual((await objectStore.get(objectInput)).bytes, objectInput.bytes);

  delete process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
  assert.deepEqual(decrypt(rotatedField), { marker: 'synthetic-field' });
  assert.deepEqual((await objectStore.get(objectInput)).bytes, objectInput.bytes);
  process.env.CAMPMIND_MASTER_KEY = oldKey;
  assert.throws(() => decrypt(rotatedField));
  await assert.rejects(() => objectStore.get(objectInput), /OBJECT_CORRUPT/);
  console.log(JSON.stringify({ status: 'ok', scope: 'synthetic-field-and-object-key-rotation', legacyRead: true, reencrypted: true, oldKeyRejected: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousCurrent === undefined) delete process.env.CAMPMIND_MASTER_KEY; else process.env.CAMPMIND_MASTER_KEY = previousCurrent;
  if (previousKeys === undefined) delete process.env.CAMPMIND_PREVIOUS_MASTER_KEYS; else process.env.CAMPMIND_PREVIOUS_MASTER_KEYS = previousKeys;
}
