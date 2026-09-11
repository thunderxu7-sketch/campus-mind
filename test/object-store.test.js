import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EncryptedFileObjectStore } from '../dist/apps/api/src/infra/object-store.js';
import { authenticate, login as loginUser } from '../dist/apps/api/src/domain/auth.js';
import { createContent, createMediaAsset, approveContent, readPublicMedia } from '../dist/apps/api/src/domain/service.js';
import { DEMO_PASSWORD, seedDemoState } from '../dist/apps/api/src/domain/seed.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { decrypt } from '../dist/apps/api/src/domain/crypto.js';

process.env.CAMPMIND_MASTER_KEY = 'test-master-key-never-use-in-production';
process.env.CAMPMIND_DEMO_MFA = 'true';

function allFiles(root) {
  const result = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else result.push(path);
    }
  };
  walk(root);
  return result;
}

test('encrypted object store isolates tenants and keeps plaintext out of files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'campus-mind-objects-'));
  try {
    const objectStore = new EncryptedFileObjectStore({ rootDir: root, maxBytes: 1024 });
    writeFileSync(join(root, 'stale-upload.tmp'), 'synthetic stale temp', { mode: 0o600 });
    new EncryptedFileObjectStore({ rootDir: root, maxBytes: 1024 });
    assert.equal(allFiles(root).some((file) => file.endsWith('.tmp')), false);
    const bytes = Buffer.from('synthetic private media bytes');
    const saved = await objectStore.put({ tenantId: 'tenant-a', objectKey: 'media/tenant-a/abc123', contentType: 'image/png', bytes });
    assert.equal(saved.sha256.length, 64);
    assert.deepEqual((await objectStore.get({ tenantId: 'tenant-a', objectKey: saved.objectKey })).bytes, bytes);
    await assert.rejects(() => objectStore.get({ tenantId: 'tenant-b', objectKey: saved.objectKey }), /OBJECT_NOT_FOUND/);
    await assert.rejects(() => objectStore.get({ tenantId: 'tenant-a', objectKey: '../escape' }), /OBJECT_KEY_INVALID/);
    await assert.rejects(() => objectStore.put({ tenantId: 'tenant-a', objectKey: 'media/tenant-a/too-large', contentType: 'image/png', bytes: Buffer.alloc(1025) }), /OBJECT_TOO_LARGE/);
    const files = allFiles(root);
    assert.equal(files.length, 1);
    assert.equal(statSync(files[0]).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(files[0], 'utf8'), /synthetic private media bytes/);
    const tampered = JSON.parse(readFileSync(files[0], 'utf8'));
    tampered.contentType = 'text/plain';
    writeFileSync(files[0], JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(() => objectStore.get({ tenantId: 'tenant-a', objectKey: saved.objectKey }), /OBJECT_CORRUPT/);
    await objectStore.delete({ tenantId: 'tenant-a', objectKey: saved.objectKey });
    await objectStore.delete({ tenantId: 'tenant-a', objectKey: saved.objectKey });
    await assert.rejects(() => objectStore.get({ tenantId: 'tenant-a', objectKey: saved.objectKey }), /OBJECT_NOT_FOUND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('media workflow stores a private pointer and serves only linked published content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'campus-mind-media-'));
  try {
    const state = seedDemoState();
    const objectStore = new EncryptedFileObjectStore({ rootDir: root });
    const store = new JsonStore({ initial: state, objectStore });
    const login = await loginUser(store, 'professional@campus-mind.demo', DEMO_PASSWORD);
    const auth = await authenticate(store, `Bearer ${login.token}`);
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const media = await createMediaAsset(store, auth, { filename: 'synthetic.png', mediaType: 'image/png', base64 });
    assert.match(media.objectKey, /^media\/tenant-demo\/[a-f0-9]{64}$/);
    assert.deepEqual(decrypt(media.contentCiphertext), { objectKey: media.objectKey });
    const content = await createContent(store, auth, { title: '合成图示', kind: 'media', body: '合成说明', ageMin: 12, ageMax: 18, copyrightSource: 'synthetic-only', mediaAssetId: media.id, altText: '合成文字替代' });
    await approveContent(store, auth, content.id);
    const served = await readPublicMedia(store, media.id);
    assert.equal(served.mediaType, 'image/png');
    assert.equal(served.filename, 'synthetic.png');
    assert.ok(served.bytes.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
