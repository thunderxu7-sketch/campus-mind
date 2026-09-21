import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyState } from '../dist/apps/api/src/domain/store.js';
import { PostgresStore } from '../dist/apps/api/src/infra/postgres-store.js';
import { currentTenantContext, withTenantContext } from '../dist/apps/api/src/infra/postgres-context.js';

function dependencies() {
  const states = new Map([
    ['tenant-a', emptyState()],
    ['tenant-b', emptyState()],
  ]);
  const calls = [];
  const repository = {
    kind: 'postgres',
    ready: true,
    async read(tenantId, fn) {
      calls.push({ operation: 'read', tenantId });
      return fn(structuredClone(states.get(tenantId)));
    },
    async transaction(tenantId, fn) {
      calls.push({ operation: 'transaction', tenantId });
      const draft = structuredClone(states.get(tenantId));
      const result = await fn(draft);
      states.set(tenantId, draft);
      return result;
    },
    async healthCheck() { return { schemaVersion: 2, rlsEnforced: true }; },
    calls,
  };
  const dependency = { put: async () => { throw new Error('not used'); }, get: async () => { throw new Error('not used'); }, delete: async () => {}, scan: async () => ({ status: 'clean', provider: 'synthetic-provider' }), deliver: async () => ({ status: 'sent', provider: 'synthetic-provider' }) };
  const identityRepository = { read: async (fn) => fn({ users: [], sessions: [], studentAccessCredentials: [], auditEvents: [] }), transaction: async (fn) => fn({ users: [], sessions: [], studentAccessCredentials: [], auditEvents: [] }) };
  return { repository, store: new PostgresStore({ repository, identityRepository, objectStore: dependency, mediaScanner: dependency, notificationDispatcher: dependency }) };
}

test('PostgresStore requires an asynchronous tenant context', async () => {
  const { store } = dependencies();
  assert.equal(currentTenantContext(), undefined);
  await assert.rejects(() => store.read(() => 'nope'), /TENANT_CONTEXT_REQUIRED/);
});

test('PostgresStore scopes reads and writes to the context tenant', async () => {
  const { repository, store } = dependencies();
  await withTenantContext('tenant-a', async () => {
    await store.transaction((state) => { state.tenants.push({ id: 'tenant-a-row', name: 'synthetic A', createdAt: new Date().toISOString() }); });
    const names = await store.read((state) => state.tenants.map((tenant) => tenant.name));
    assert.deepEqual(names, ['synthetic A']);
  });
  await withTenantContext('tenant-b', async () => {
    const names = await store.read((state) => state.tenants.map((tenant) => tenant.name));
    assert.deepEqual(names, []);
  });
  assert.deepEqual(repository.calls.map((call) => call.tenantId), ['tenant-a', 'tenant-a', 'tenant-b']);
});

test('PostgresStore exposes RLS health and provider boundaries', async () => {
  const { store } = dependencies();
  assert.deepEqual(await store.healthCheck(), { schemaVersion: 2, rlsEnforced: true });
  assert.equal(store.adapterKind, 'postgres');
  assert.equal(store.productionReady, true);
  assert.ok(store.objectStore);
  assert.ok(store.mediaScanner);
  assert.ok(store.notificationDispatcher);
});

test('PostgresStore rejects an unready repository or missing provider', () => {
  const { repository } = dependencies();
  const identityRepository = { read: async (fn) => fn({ users: [], sessions: [], studentAccessCredentials: [], auditEvents: [] }), transaction: async (fn) => fn({ users: [], sessions: [], studentAccessCredentials: [], auditEvents: [] }) };
  assert.throws(() => new PostgresStore({ repository: { ...repository, ready: false }, identityRepository, objectStore: repository, mediaScanner: repository, notificationDispatcher: repository }), /POSTGRES_REPOSITORY_NOT_READY/);
  assert.throws(() => new PostgresStore({ repository, identityRepository, objectStore: undefined, mediaScanner: repository, notificationDispatcher: repository }), /PRIVATE_OBJECT_STORE_REQUIRED/);
  assert.throws(() => new PostgresStore({ repository, identityRepository: undefined, objectStore: repository, mediaScanner: repository, notificationDispatcher: repository }), /IDENTITY_REPOSITORY_REQUIRED/);
});
