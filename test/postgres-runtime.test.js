import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostgresPool, probePostgresPool, resolvePostgresRuntimeOptions } from '../dist/apps/api/src/infra/postgres-runtime.js';

const syntheticEnv = (overrides = {}) => ({
  NODE_ENV: 'test',
  CAMPMIND_POSTGRES_URL: 'postgresql://synthetic.invalid/campus_mind',
  ...overrides,
});

test('PostgreSQL runtime resolves bounded pool settings without exposing credentials', () => {
  const resolved = resolvePostgresRuntimeOptions({ max: 12, applicationName: 'synthetic-test' }, syntheticEnv({ CAMPMIND_POSTGRES_POOL_MAX: '20' }));
  assert.equal(resolved.connectionString, 'postgresql://synthetic.invalid/campus_mind');
  assert.equal(resolved.max, 12);
  assert.equal(resolved.idleTimeoutMillis, 30_000);
  assert.equal(resolved.connectionTimeoutMillis, 5_000);
  assert.equal(resolved.applicationName, 'synthetic-test');
  assert.equal(resolved.ssl, undefined);
});

test('production PostgreSQL runtime requires TLS and accepts explicit certificate validation', () => {
  assert.throws(() => resolvePostgresRuntimeOptions({}, syntheticEnv({ NODE_ENV: 'production' })), /POSTGRES_TLS_REQUIRED/);
  assert.throws(() => resolvePostgresRuntimeOptions({ ssl: { rejectUnauthorized: false } }, syntheticEnv({ NODE_ENV: 'production' })), /POSTGRES_TLS_VERIFY_REQUIRED/);
  const resolved = resolvePostgresRuntimeOptions({ ssl: { rejectUnauthorized: true } }, syntheticEnv({ NODE_ENV: 'production' }));
  assert.deepEqual(resolved.ssl, { rejectUnauthorized: true });
});

test('PostgreSQL runtime rejects malformed URLs and unsafe pool values', () => {
  assert.throws(() => resolvePostgresRuntimeOptions({}, syntheticEnv({ CAMPMIND_POSTGRES_URL: 'https://not-postgres.invalid' })), /POSTGRES_URL_INVALID/);
  assert.throws(() => resolvePostgresRuntimeOptions({}, syntheticEnv({ CAMPMIND_POSTGRES_POOL_MAX: '0' })), /POSTGRES_POOL_MAX_INVALID/);
  assert.throws(() => resolvePostgresRuntimeOptions({ applicationName: 'synthetic\nname' }, syntheticEnv()), /POSTGRES_APPLICATION_NAME_INVALID/);
});

test('PostgreSQL runtime probe uses a short-lived client and does not read application data', async () => {
  const calls = [];
  let releases = 0;
  const pool = {
    async connect() {
      return {
        async query(sql, values) { calls.push({ sql, values }); return { rows: [{ ok: 1 }] }; },
        release() { releases += 1; },
      };
    },
  };
  assert.deepEqual(await probePostgresPool(pool), { connected: true });
  assert.deepEqual(calls, [{ sql: 'select 1', values: undefined }]);
  assert.equal(releases, 1);
});

test('PostgreSQL runtime creates a pg pool without opening a connection during construction', async () => {
  const pool = createPostgresPool({ max: 2 }, syntheticEnv());
  assert.equal(typeof pool.connect, 'function');
  assert.equal(typeof pool.end, 'function');
  await pool.end();
});
