import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRiskSignal, createRightsRequest, completeRightsRequest, drainOutbox, escalateUnacknowledged, processRetention } from '../dist/apps/api/src/domain/service.js';
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
  await store.transaction((state) => { state.riskCases.find((candidate) => candidate.id === riskCase.id).updatedAt = '2020-01-01T00:00:00.000Z'; });
  const opsAuth = authFor(store.snapshot(), 'user-ops-demo');
  const escalated = await escalateUnacknowledged(store, opsAuth, { asOf: '2026-09-11T00:00:00.000Z', thresholdMinutes: 30 });
  assert.deepEqual(escalated, { escalated: 1 });
  const drained = await drainOutbox(store);
  assert.ok(drained.processed >= 1);
  const after = store.snapshot();
  assert.ok(after.deliveryAttempts.filter((attempt) => attempt.status === 'sent').length >= 2);
  assert.equal(after.riskCases.find((candidate) => candidate.id === riskCase.id).state, 'pending_review');
  assert.equal(after.acknowledgements.length, 0);
});

test('outbox failures leave a redacted delivery attempt and a retryable dead letter', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  await store.transaction((state) => {
    state.outboxEvents.push({ id: 'broken-scoring-event', tenantId: 'tenant-demo', type: 'assessment.submitted', aggregateId: 'missing-attempt', payload: {}, status: 'pending', attempts: 4, availableAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  });
  const result = await drainOutbox(store, 1);
  assert.deepEqual(result, { processed: 0, failed: 1 });
  const state = store.snapshot();
  assert.equal(state.outboxEvents.find((event) => event.id === 'broken-scoring-event').status, 'dead_letter');
  assert.equal(state.deliveryAttempts.find((attempt) => attempt.outboxEventId === 'broken-scoring-event').status, 'failed');
  assert.match(state.deliveryAttempts.find((attempt) => attempt.outboxEventId === 'broken-scoring-event').errorCode, /^[A-Z0-9_:-]+$/);
  assert.doesNotMatch(state.deliveryAttempts.find((attempt) => attempt.outboxEventId === 'broken-scoring-event').errorCode, /missing-attempt/);
});

test('delete rights workflow removes sensitive derivatives and leaves a minimal tombstone', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const studentAuth = authFor(store.snapshot(), 'student-demo');
  const privacyAuth = authFor(store.snapshot(), 'user-privacy-demo');
  await store.transaction((state) => {
    state.studentAccessCredentials.push({ id: 'delete-credential-drill', tenantId: 'tenant-demo', studentId: 'student-demo', codeHash: 'synthetic-code-hash', expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedBy: 'user-admin-demo', createdAt: new Date().toISOString() });
    state.importBatches.push({ id: 'expired-import-drill', tenantId: 'tenant-demo', schoolId: 'school-demo', createdBy: 'user-admin-demo', filename: 'synthetic.csv', status: 'previewed', mappingVersion: 1, rowCount: 1, validRowCount: 1, errorCount: 0, previewHash: 'synthetic-hash', createdAt: '2020-01-01T00:00:00.000Z' });
    state.importRows.push({ id: 'expired-import-row-drill', tenantId: 'tenant-demo', batchId: 'expired-import-drill', rowNumber: 1, status: 'valid' });
    state.exportJobs.push({ id: 'student-export-drill', tenantId: 'tenant-demo', requestedBy: 'student-demo', purpose: 'synthetic_delete_drill', kind: 'report', studentId: 'student-demo', status: 'ready', expiresAt: new Date(Date.now() + 60_000).toISOString(), payloadCiphertext: 'synthetic-ciphertext', createdAt: new Date().toISOString() });
    state.attempts.push({ id: 'delete-attempt-drill', tenantId: 'tenant-demo', assignmentId: 'assignment-demo', studentId: 'student-demo', scaleVersionId: 'scale-synthetic-demo-v1', state: 'scoring_pending', currentRevision: 1, startedAt: new Date().toISOString(), submissionId: 'delete-submission-drill' });
    state.answerRevisions.push({ id: 'delete-revision-drill', tenantId: 'tenant-demo', attemptId: 'delete-attempt-drill', revision: 1, answersCiphertext: 'synthetic-ciphertext', savedAt: new Date().toISOString(), actorId: 'student-demo' });
    state.submissions.push({ id: 'delete-submission-drill', tenantId: 'tenant-demo', attemptId: 'delete-attempt-drill', answerRevisionId: 'delete-revision-drill', idempotencyKey: 'delete-drill-key', contentHash: 'synthetic-hash', submittedAt: new Date().toISOString() });
    state.outboxEvents.push({ id: 'delete-triage-drill', tenantId: 'tenant-demo', type: 'risk.triage', aggregateId: 'delete-attempt-drill', payload: { submissionId: 'delete-submission-drill' }, status: 'pending', attempts: 0, availableAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    state.riskCases.push({ id: 'delete-case-drill', tenantId: 'tenant-demo', studentId: 'student-demo', state: 'assigned', priority: 'urgent', signalIds: [], assignedTo: 'user-counselor-demo', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    state.riskReviews.push({ id: 'delete-review-drill', tenantId: 'tenant-demo', caseId: 'delete-case-drill', reviewerId: 'user-professional-demo', decision: 'confirm', noteCiphertext: 'synthetic-ciphertext', createdAt: new Date().toISOString() });
    state.acknowledgements.push({ id: 'delete-ack-drill', tenantId: 'tenant-demo', caseId: 'delete-case-drill', userId: 'user-counselor-demo', acknowledgedAt: new Date().toISOString() });
    state.outboxEvents.push({ id: 'delete-escalation-drill', tenantId: 'tenant-demo', type: 'risk.escalation', aggregateId: 'delete-case-drill', payload: { caseId: 'delete-case-drill', reason: 'synthetic' }, status: 'pending', attempts: 0, availableAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  });
  const request = await createRightsRequest(store, studentAuth, { studentId: 'student-demo', kind: 'delete', reason: '合成演示删除申请' });
  const completed = await completeRightsRequest(store, privacyAuth, request.id, 'complete');
  assert.equal(completed.status, 'completed');
  const state = store.snapshot();
  assert.equal(state.students.find((student) => student.id === 'student-demo').active, false);
  assert.equal(state.students.find((student) => student.id === 'student-demo').age, undefined);
  assert.equal(state.students.find((student) => student.id === 'student-demo').classId, 'deleted');
  assert.equal(state.reports.length, 0);
  assert.equal(state.riskCases.length, 0);
  assert.equal(state.riskReviews.length, 0);
  assert.equal(state.acknowledgements.length, 0);
  assert.equal(state.profileResponses.length, 0);
  assert.equal(state.appointments.length, 0);
  assert.equal(state.assignments.some((assignment) => assignment.studentId === 'student-demo'), false);
  assert.equal(state.frequencyReservations.some((reservation) => reservation.studentId === 'student-demo'), false);
  assert.equal(state.guardianLinks.some((link) => link.studentId === 'student-demo'), false);
  assert.equal(state.users.find((user) => user.id === 'student-demo').active, false);
  assert.equal(state.studentAccessCredentials.some((credential) => credential.studentId === 'student-demo'), false);
  assert.equal(state.campaigns.every((campaign) => !campaign.participantStudentIds.includes('student-demo')), true);
  assert.equal(state.outboxEvents.some((event) => event.type === 'risk.triage'), false);
  assert.equal(state.outboxEvents.some((event) => event.type === 'risk.escalation'), false);
  assert.equal(state.exportJobs.find((job) => job.id === 'student-export-drill').status, 'revoked');
  assert.equal(state.exportJobs.find((job) => job.id === 'student-export-drill').payloadCiphertext, undefined);
  assert.equal(state.deletionTombstones.length, 1);
  assert.deepEqual(state.deletionTombstones[0].retainedCategories, ['minimal_audit_event', 'deletion_tombstone']);

  // Simulate a restore that resurrects an active student and an export payload.
  const restoredState = store.snapshot();
  restoredState.students.find((student) => student.id === 'student-demo').active = true;
  restoredState.users.find((user) => user.id === 'student-demo').active = true;
  restoredState.exportJobs.push({ id: 'expired-after-restore', tenantId: 'tenant-demo', requestedBy: 'student-demo', purpose: 'synthetic_restore_drill', kind: 'report', studentId: 'student-demo', status: 'ready', expiresAt: '2020-01-01T00:00:00.000Z', payloadCiphertext: 'synthetic-ciphertext', createdAt: new Date().toISOString() });
  const restored = new JsonStore({ initial: restoredState });
  const opsAuth = authFor(restored.snapshot(), 'user-ops-demo');
  const replay = await processRetention(restored, opsAuth, '2026-09-11T00:00:00.000Z');
  assert.deepEqual(replay, { expiredExports: 1, expiredImportPreviews: 1, replayedDeletions: 1 });
  assert.equal(restored.snapshot().importBatches.some((batch) => batch.id === 'expired-import-drill'), false);
  assert.equal(restored.snapshot().importRows.some((row) => row.id === 'expired-import-row-drill'), false);
  assert.equal(restored.snapshot().students.find((student) => student.id === 'student-demo').active, false);
  assert.equal(restored.snapshot().exportJobs.find((job) => job.id === 'expired-after-restore').status, 'revoked');
  const replayAgain = await processRetention(restored, opsAuth, '2026-09-11T00:00:00.000Z');
  assert.deepEqual(replayAgain, { expiredExports: 0, expiredImportPreviews: 0, replayedDeletions: 0 });
});
