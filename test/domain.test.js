import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCampaign, publishCampaign } from '../dist/apps/api/src/domain/service.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState } from '../dist/apps/api/src/domain/seed.js';

function authFor(state, userId) {
  const user = state.users.find((candidate) => candidate.id === userId);
  return { user, session: { tokenHash: 'test', userId, tenantId: user.tenantId, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() } };
}

test('file adapter reloads encrypted state without losing new collections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'campus-mind-'));
  const filePath = join(directory, 'state.json');
  const first = new JsonStore({ filePath, initial: seedDemoState() });
  await first.transaction((state) => { state.auditEvents.push({ id: 'persist-test', tenantId: 'tenant-demo', action: 'test', objectType: 'test', objectId: 'persist-test', metadata: {}, createdAt: new Date().toISOString() }); });
  const second = new JsonStore({ filePath });
  const snapshot = second.snapshot();
  assert.ok(snapshot.auditEvents.some((event) => event.id === 'persist-test'));
  assert.ok(Array.isArray(snapshot.profileResponses));
  assert.ok(Array.isArray(snapshot.exportJobs));
});

test('frequency reservation is atomic when two campaigns publish concurrently', async () => {
  const state = seedDemoState();
  state.campaigns = [];
  state.assignments = [];
  state.frequencyReservations = [];
  const store = new JsonStore({ initial: state });
  const auth = authFor(store.snapshot(), 'user-admin-demo');
  const base = { schoolId: 'school-demo', purpose: 'screening', academicYear: '2026-2027', opensAt: new Date(Date.now() - 1_000).toISOString(), closesAt: new Date(Date.now() + 3_600_000).toISOString(), scaleVersionId: 'scale-synthetic-demo-v1', participantStudentIds: ['student-demo'] };
  const first = await createCampaign(store, auth, { ...base, name: '合成并发任务 A' });
  const second = await createCampaign(store, auth, { ...base, name: '合成并发任务 B' });
  const results = await Promise.allSettled([publishCampaign(store, auth, first.id), publishCampaign(store, auth, second.id)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'FREQUENCY_REVIEW_REQUIRED').length, 1);
  assert.equal(store.snapshot().frequencyReservations.length, 1);
});
