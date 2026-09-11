import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score, assertUsableScale } from '../dist/apps/api/src/domain/scoring.js';
import { assertProductionConfig, decrypt, encrypt, reencrypt, totpCode, verifyTotpCode } from '../dist/apps/api/src/domain/crypto.js';

const scale = {
  id: 'gold-scale', tenantId: 'tenant', code: 'SYNTH-GOLD', title: '合成计分金标准', version: '1.0.0', provenance: 'synthetic_only', status: 'approved', minAge: 12, maxAge: 18, scoringVersion: 'gold-v1', noticeVersion: 'notice',
  items: [
    { id: 'normal', prompt: 'x', min: 0, max: 3, reverse: false, factor: 'a' },
    { id: 'reverse', prompt: 'y', min: 0, max: 3, reverse: true, factor: 'a' },
    { id: 'factor-b', prompt: 'z', min: 0, max: 1, reverse: false, factor: 'b' },
  ],
};

test('independent scoring golden vectors cover reverse, factors and exact total', () => {
  const output = score(scale, { normal: 2, reverse: 1, 'factor-b': 1 });
  // Expected values are hand-calculated from the scale contract, not copied from the implementation.
  assert.deepEqual(output, { factorScores: { a: 4, b: 1 }, total: 5, validity: 'valid' });
});

test('invalid answer vectors never become a normal result', () => {
  assert.equal(score(scale, { normal: 2, reverse: 1 }).validity, 'invalid');
  assert.equal(score(scale, { normal: 4, reverse: 1, 'factor-b': 1 }).validity, 'invalid');
  assert.equal(score(scale, { normal: 2, reverse: 1, 'factor-b': 2 }).validity, 'invalid');
});

test('synthetic scales are barred only in production mode', () => {
  const previous = process.env.NODE_ENV;
  const previousKey = process.env.CAMPMIND_MASTER_KEY;
  const previousBackend = process.env.CAMPMIND_DATA_BACKEND;
  const previousDemoMfa = process.env.CAMPMIND_DEMO_MFA;
  process.env.NODE_ENV = 'production';
  assert.throws(() => assertUsableScale(scale), /演示量表/);
  process.env.CAMPMIND_MASTER_KEY = 'dedicated-production-test-key-1234567890';
  process.env.CAMPMIND_DATA_BACKEND = 'json';
  process.env.CAMPMIND_DEMO_MFA = 'false';
  assert.throws(() => assertProductionConfig(), /CAMPMIND_DATA_BACKEND/);
  process.env.CAMPMIND_DATA_BACKEND = 'postgres';
  process.env.CAMPMIND_DEMO_MFA = 'true';
  assert.throws(() => assertProductionConfig(), /CAMPMIND_DEMO_MFA/);
  process.env.NODE_ENV = previous;
  process.env.CAMPMIND_MASTER_KEY = previousKey;
  process.env.CAMPMIND_DATA_BACKEND = previousBackend;
  process.env.CAMPMIND_DEMO_MFA = previousDemoMfa;
});

test('TOTP helper follows the RFC 6238 SHA-1 vector and bounded clock skew', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(verifyTotpCode(secret, '287082', 59_000), true);
  assert.equal(verifyTotpCode(secret, '287082', 59_000 + 90_000), false);
  assert.equal(verifyTotpCode(secret, 'abcdef', 59_000), false);
});

test('field encryption supports bounded key rotation without persisting key material', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCurrent = process.env.CAMPMIND_MASTER_KEY;
  const previousKeys = process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
  process.env.NODE_ENV = 'test';
  const oldKey = 'old-dedicated-test-key-for-rotation-2026';
  process.env.CAMPMIND_MASTER_KEY = oldKey;
  delete process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
  const legacyEnvelope = encrypt({ marker: 'legacy-value' });

  process.env.CAMPMIND_MASTER_KEY = 'new-dedicated-test-key-for-rotation-2026';
  process.env.CAMPMIND_PREVIOUS_MASTER_KEYS = oldKey;
  assert.deepEqual(decrypt(legacyEnvelope), { marker: 'legacy-value' });
  const rotatedEnvelope = reencrypt(legacyEnvelope);
  assert.deepEqual(decrypt(rotatedEnvelope), { marker: 'legacy-value' });
  delete process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
  assert.throws(() => decrypt(legacyEnvelope));

  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousCurrent === undefined) delete process.env.CAMPMIND_MASTER_KEY; else process.env.CAMPMIND_MASTER_KEY = previousCurrent;
  if (previousKeys === undefined) delete process.env.CAMPMIND_PREVIOUS_MASTER_KEYS; else process.env.CAMPMIND_PREVIOUS_MASTER_KEYS = previousKeys;
});
