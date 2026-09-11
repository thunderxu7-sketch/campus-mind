import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTenantPoolTransaction, withTenantTransaction } from '../dist/apps/api/src/infra/postgres-context.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT FAIL') throw new Error('synthetic failure');
      return { rows: [] };
    },
  };
}

test('tenant transaction sets a local context and commits', async () => {
  const client = fakeClient();
  const result = await withTenantTransaction(client, 'tenant-a', async (scoped) => {
    assert.equal(scoped, client);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(client.calls, [
    { sql: 'BEGIN', values: undefined },
    { sql: "select set_config('app.tenant_id', $1, true)", values: ['tenant-a'] },
    { sql: 'COMMIT', values: undefined },
  ]);
});

test('tenant transaction rolls back after a query failure', async () => {
  const client = fakeClient();
  await assert.rejects(() => withTenantTransaction(client, 'tenant-a', async (scoped) => {
    await scoped.query('SELECT FAIL');
    return 'unreachable';
  }), /synthetic failure/);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('invalid tenant context is rejected before a transaction starts', async () => {
  const client = fakeClient();
  await assert.rejects(() => withTenantTransaction(client, 'tenant-a\nset role owner', async () => 'nope'), /TENANT_CONTEXT_INVALID/);
  assert.equal(client.calls.length, 0);
});

test('pool connection is released after success and failure', async () => {
  const client = fakeClient();
  let releases = 0;
  const pool = { async connect() { return { ...client, release() { releases += 1; } }; } };
  await withTenantPoolTransaction(pool, 'tenant-a', async () => 'ok');
  assert.equal(releases, 1);
  await assert.rejects(() => withTenantPoolTransaction(pool, 'tenant-a', async (scoped) => { await scoped.query('SELECT FAIL'); return 'nope'; }));
  assert.equal(releases, 2, 'failure path releases exactly once');
});
