import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticate, login, logout } from '../dist/apps/api/src/domain/auth.js';
import { DEMO_PASSWORD, seedDemoState } from '../dist/apps/api/src/domain/seed.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';

process.env.CAMPMIND_DEMO_MFA = 'true';
process.env.CAMPMIND_MASTER_KEY = 'test-master-key-never-use-in-production';

test('expired and logged-out sessions cannot authenticate and safe users omit secrets', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const result = await login(store, 'student@campus-mind.demo', DEMO_PASSWORD);
  assert.equal(Object.hasOwn(result.user, 'passwordHash'), false);
  assert.equal(Object.hasOwn(result.user, 'mfaSecretCiphertext'), false);
  const authorization = `Bearer ${result.token}`;
  const authenticated = await authenticate(store, authorization);
  assert.equal(authenticated.user.id, 'student-demo');

  await logout(store, authenticated.session);
  await assert.rejects(() => authenticate(store, authorization), (error) => error.code === 'UNAUTHORIZED');

  const second = await login(store, 'student@campus-mind.demo', DEMO_PASSWORD);
  await store.transaction((state) => {
    const latest = state.sessions.find((candidate) => candidate.userId === 'student-demo' && !candidate.revokedAt);
    assert.ok(latest);
    latest.expiresAt = new Date(Date.now() - 1_000).toISOString();
  });
  await assert.rejects(() => authenticate(store, `Bearer ${second.token}`), (error) => error.code === 'UNAUTHORIZED');
});
