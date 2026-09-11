import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveFrequencyException, approveScale, beginAttempt, createCampaign, createScale, createSelfScreening, publishCampaign, revokeScale, saveAnswers, updateCampaignState, withdrawConsent } from '../dist/apps/api/src/domain/service.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { DEMO_IDS, seedDemoState } from '../dist/apps/api/src/domain/seed.js';

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


test('self screening uses the same consent and academic-year frequency guard', async () => {
  const state = seedDemoState();
  state.campaigns = [];
  state.assignments = [];
  state.frequencyReservations = [];
  const store = new JsonStore({ initial: state });
  const auth = authFor(store.snapshot(), 'student-demo');
  const first = await createSelfScreening(store, auth, 'scale-synthetic-demo-v1');
  assert.equal(first.campaign.purpose, 'screening');
  await assert.rejects(() => createSelfScreening(store, auth, 'scale-synthetic-demo-v1'), (error) => error.code === 'FREQUENCY_REVIEW_REQUIRED');
});

test('professional frequency exceptions are explicit and scoped to one draft campaign', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const snapshot = store.snapshot();
  const admin = authFor(snapshot, 'user-admin-demo');
  const professional = authFor(snapshot, 'user-professional-demo');
  const campaign = await createCampaign(store, admin, { schoolId: 'school-demo', name: '合成复评例外任务', purpose: 'screening', academicYear: '2026-2027', opensAt: new Date(Date.now() - 1_000).toISOString(), closesAt: new Date(Date.now() + 3_600_000).toISOString(), scaleVersionId: 'scale-synthetic-demo-v1', participantStudentIds: ['student-demo'] });
  const reservation = await approveFrequencyException(store, professional, campaign.id, { studentId: 'student-demo', reason: '合成演示：专业人员记录必要复评用途' });
  assert.equal(reservation.status, 'exception');
  await publishCampaign(store, admin, campaign.id);
  assert.equal(store.snapshot().assignments.filter((assignment) => assignment.campaignId === campaign.id).length, 1);
});

test('closing an unfinished campaign expires drafts and releases unused frequency reservations', async () => {
  const state = seedDemoState();
  state.campaigns = [];
  state.assignments = [];
  state.frequencyReservations = [];
  const store = new JsonStore({ initial: state });
  const admin = authFor(store.snapshot(), 'user-admin-demo');
  const campaign = await createCampaign(store, admin, { schoolId: 'school-demo', name: '合成未完成任务', purpose: 'screening', academicYear: '2026-2027', opensAt: new Date(Date.now() - 1_000).toISOString(), closesAt: new Date(Date.now() + 3_600_000).toISOString(), scaleVersionId: 'scale-synthetic-demo-v1', participantStudentIds: ['student-demo'] });
  await publishCampaign(store, admin, campaign.id);
  await updateCampaignState(store, admin, campaign.id, 'closed');
  assert.equal(store.snapshot().assignments[0].status, 'expired');
  assert.equal(store.snapshot().frequencyReservations[0].status, 'released');
});

test('declined or completed assignments cannot be reopened after their session is closed', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const student = await store.read((state) => state.users.find((user) => user.id === DEMO_IDS.student));
  assert.ok(student);
  const auth = { user: student, session: { tokenHash: 'synthetic', userId: student.id, tenantId: student.tenantId, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() } };
  await store.transaction((state) => { state.assignments.find((assignment) => assignment.id === DEMO_IDS.assignment).status = 'declined'; });
  await assert.rejects(() => beginAttempt(store, auth, DEMO_IDS.assignment), (error) => error.code === 'ASSIGNMENT_NOT_AVAILABLE');
});

test('revoking a scale blocks new use without changing historical identifiers', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const professional = authFor(store.snapshot(), 'user-professional-demo');
  await revokeScale(store, professional, 'scale-synthetic-demo-v1', '合成演示撤销');
  assert.equal(store.snapshot().scales.find((scale) => scale.id === 'scale-synthetic-demo-v1').status, 'revoked');
  assert.equal(store.snapshot().campaigns.find((campaign) => campaign.id === 'campaign-demo').scaleVersionId, 'scale-synthetic-demo-v1');
  await assert.rejects(() => approveScale(store, professional, 'scale-synthetic-demo-v1'), (error) => error.code === 'SCALE_REVOKED');
});

test('scale author cannot approve their own draft version', async () => {
  const state = seedDemoState();
  const reviewerTemplate = state.users.find((user) => user.id === 'user-professional-demo');
  state.users.push({ ...reviewerTemplate, id: 'user-professional-reviewer', email: 'reviewer@campus-mind.demo', displayName: '合成独立复核者' });
  const store = new JsonStore({ initial: state });
  const author = authFor(store.snapshot(), 'user-professional-demo');
  const reviewer = authFor(store.snapshot(), 'user-professional-reviewer');
  const scale = await createScale(store, author, { code: 'SYNTH-SEPARATION', title: '合成分离职责方案', version: '1.0.0', provenance: 'synthetic_only', minAge: 12, maxAge: 18, scoringVersion: 'synthetic-separation-v1', noticeVersion: 'notice-demo-v1', items: [{ id: 'q1', prompt: '合成题', min: 0, max: 1, reverse: false, factor: 'factor' }] });
  await assert.rejects(() => approveScale(store, author, scale.id), (error) => error.code === 'SEPARATION_OF_DUTIES_REQUIRED');
  const approved = await approveScale(store, reviewer, scale.id);
  assert.equal(approved.status, 'approved');
});

test('assessment consent withdrawal stops an in-progress draft and pending processing', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const student = authFor(store.snapshot(), 'student-demo');
  const started = await beginAttempt(store, student, 'assignment-demo');
  await saveAnswers(store, student, started.attempt.id, { expectedRevision: 0, answers: { q1: 1 } });
  const consent = store.snapshot().consents.find((record) => record.studentId === 'student-demo' && record.purpose === 'assessment' && record.status === 'active');
  await withdrawConsent(store, student, consent.id);
  assert.equal(store.snapshot().attempts.find((attempt) => attempt.id === started.attempt.id).state, 'withdrawn');
  await assert.rejects(() => saveAnswers(store, student, started.attempt.id, { expectedRevision: 1, answers: { q1: 0 } }), (error) => error.code === 'NOT_FOUND');
  assert.equal(store.snapshot().outboxEvents.some((event) => event.type === 'assessment.submitted'), false);
});
