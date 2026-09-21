import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NormalizedPostgresStateRepository, postgresStateTableNames } from '../dist/apps/api/src/infra/postgres-state-repository.js';

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("from pg_class where relnamespace")) return { rows: [{ count: 41 }] };
      return { rows: [] };
    },
    release() { calls.push({ release: true }); },
  };
  return { calls, async connect() { return client; } };
}

test('normalized PostgreSQL repository exposes the complete fixed table set', () => {
  const names = postgresStateTableNames();
  assert.equal(names.length, 41);
  assert.ok(names.includes('expression_entries'));
  assert.ok(names.includes('support_requests'));
  assert.ok(names.includes('outbox_events'));
  assert.equal(new Set(names).size, names.length);
});

test('normalized PostgreSQL repository wraps loads and writes in tenant transactions', async () => {
  const pool = fakePool();
  const repository = new NormalizedPostgresStateRepository({ pool });
  const health = await repository.healthCheck();
  assert.deepEqual(health, { schemaVersion: 2, rlsEnforced: true });
  const result = await repository.transaction('tenant-a', (state) => {
    state.tenants.push({ id: 'tenant-a', name: 'synthetic tenant', createdAt: new Date().toISOString() });
    return state.schemaVersion;
  });
  assert.equal(result, 2);
  assert.equal(pool.calls.filter((call) => call.sql === 'BEGIN').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1);
  assert.ok(pool.calls.some((call) => typeof call.sql === 'string' && call.sql.includes("set_config('app.tenant_id', $1, true)") && call.values[0] === 'tenant-a'));
  assert.ok(pool.calls.some((call) => typeof call.sql === 'string' && call.sql.includes('pg_advisory_xact_lock')));
  assert.ok(pool.calls.some((call) => typeof call.sql === 'string' && call.sql.startsWith('insert into "tenants"')));
});

test('normalized PostgreSQL repository refuses work before the readiness check', async () => {
  const pool = fakePool();
  const repository = new NormalizedPostgresStateRepository({ pool });
  await assert.rejects(() => repository.read('tenant-a', () => 'nope'), /POSTGRES_REPOSITORY_NOT_READY/);
  assert.equal(pool.calls.length, 0);
});

test('normalized PostgreSQL repository restores the tenant id on scoped rows', async () => {
  const pool = fakePool();
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query;
    client.query = async (sql, values) => {
      if (typeof sql === 'string' && sql.includes('from "schools"')) return { rows: [{ tenant_id: 'tenant-a', id: 'school-a', name: 'synthetic school', created_at: '2026-09-21T00:00:00.000Z' }] };
      return originalQuery(sql, values);
    };
    return client;
  };
  const repository = new NormalizedPostgresStateRepository({ pool });
  await repository.healthCheck();
  const tenantId = await repository.read('tenant-a', (state) => state.schools[0]?.tenantId);
  assert.equal(tenantId, 'tenant-a');
});

test('normalized PostgreSQL repository rejects malformed tenant context before SQL', async () => {
  const pool = fakePool();
  const repository = new NormalizedPostgresStateRepository({ pool });
  await assert.rejects(() => repository.read('tenant-a\nset role owner', () => 'nope'), /TENANT_CONTEXT_INVALID/);
  assert.equal(pool.calls.length, 0);
});

test('normalized PostgreSQL repository fails closed when any mapped table lacks FORCE RLS', async () => {
  const pool = fakePool();
  pool.connect = async () => ({
    async query(sql) {
      if (sql.includes('from pg_class')) return { rows: [{ count: 40 }] };
      return { rows: [] };
    },
    release() {},
  });
  const repository = new NormalizedPostgresStateRepository({ pool });
  await assert.rejects(() => repository.healthCheck(), /POSTGRES_RLS_NOT_READY/);
  assert.equal(repository.ready, false);
});
