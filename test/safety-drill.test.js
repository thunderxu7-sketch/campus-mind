import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRiskSignal, createRightsRequest, completeRightsRequest, drainOutbox } from '../dist/apps/api/src/domain/service.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState } from '../dist/apps/api/src/domain/seed.js';

function authFor(state, userId) {
  const user = state.users.find((candidate) => candidate.id === userId);
  return { user, session: { tokenHash: 'drill', userId, tenantId: user.tenantId, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() } };
}

test('urgent self-help survives worker delivery and still requires human acknowledgement', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const studentAuth = authFor(store.snapshot(), 'student-demo');
  const riskCase = await createRiskSignal(store, studentAuth, { studentId: 'student-demo', level: 'urgent', reason: '合成演示：学生主动申请紧急人工支持' });
  const before = store.snapshot();
  assert.equal(before.riskCases.find((candidate) => candidate.id === riskCase.id).state, 'pending_review');
  const drained = await drainOutbox(store);
  assert.ok(drained.processed >= 1);
  const after = store.snapshot();
  assert.ok(after.deliveryAttempts.some((attempt) => attempt.outboxEventId && attempt.status === 'sent'));
  assert.equal(after.riskCases.find((candidate) => candidate.id === riskCase.id).state, 'pending_review');
  assert.equal(after.acknowledgements.length, 0);
});

test('delete rights workflow removes sensitive derivatives and leaves a minimal tombstone', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const studentAuth = authFor(store.snapshot(), 'student-demo');
  const privacyAuth = authFor(store.snapshot(), 'user-privacy-demo');
  const request = await createRightsRequest(store, studentAuth, { studentId: 'student-demo', kind: 'delete', reason: '合成演示删除申请' });
  const completed = await completeRightsRequest(store, privacyAuth, request.id, 'complete');
  assert.equal(completed.status, 'completed');
  const state = store.snapshot();
  assert.equal(state.students.find((student) => student.id === 'student-demo').active, false);
  assert.equal(state.reports.length, 0);
  assert.equal(state.riskCases.length, 0);
  assert.equal(state.profileResponses.length, 0);
  assert.equal(state.appointments.length, 0);
  assert.equal(state.deletionTombstones.length, 1);
  assert.deepEqual(state.deletionTombstones[0].retainedCategories, ['minimal_audit_event', 'deletion_tombstone']);
});
