import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveFrequencyException, approveScale, beginAttempt, createCampaign, createConsent, createScale, createSelfScreening, listAvailableScales, listMyTasks, listScaleCatalog, publishCampaign, revokeScale, saveAnswers, updateCampaignState, withdrawConsent } from '../dist/apps/api/src/domain/service.js';
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
  await assert.rejects(() => createCampaign(store, auth, { ...base, name: '合成非法学年任务', academicYear: '2026/2027' }), (error) => error.code === 'CAMPAIGN_INVALID');
  await assert.rejects(() => createCampaign(store, auth, { ...base, name: 'x'.repeat(201) }), (error) => error.code === 'CAMPAIGN_INVALID');
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
  const previousAcademicYear = process.env.CAMPMIND_ACADEMIC_YEAR;
  try {
    process.env.CAMPMIND_ACADEMIC_YEAR = 'not-a-school-year';
    await assert.rejects(() => createSelfScreening(store, auth, 'scale-synthetic-demo-v1'), (error) => error.code === 'ACADEMIC_YEAR_CONFIG_INVALID');
  } finally {
    if (previousAcademicYear === undefined) delete process.env.CAMPMIND_ACADEMIC_YEAR; else process.env.CAMPMIND_ACADEMIC_YEAR = previousAcademicYear;
  }
  await assert.rejects(() => createSelfScreening(store, auth, 'scale-synthetic-demo-v1', '9999-10000'), (error) => error.code === 'ACADEMIC_YEAR_INVALID');
  await store.transaction((draft) => { draft.scales.find((candidate) => candidate.id === 'scale-synthetic-demo-v1').noticeVersion = 'notice-updated-v2'; });
  await assert.rejects(() => createSelfScreening(store, auth, 'scale-synthetic-demo-v1'), (error) => error.code === 'CONSENT_REQUIRED');
  const renewed = await createConsent(store, auth, { studentId: 'student-demo', actorType: 'student', noticeVersion: 'notice-updated-v2', purpose: 'assessment' });
  assert.equal(renewed.noticeVersion, 'notice-updated-v2');
  assert.equal(store.snapshot().consents.filter((consent) => consent.purpose === 'assessment' && consent.status === 'active').length, 1);
  const first = await createSelfScreening(store, auth, 'scale-synthetic-demo-v1');
  assert.equal(first.campaign.purpose, 'screening');
  assert.equal(Object.hasOwn(first.campaign, 'tenantId'), false);
  assert.equal(Object.hasOwn(first.campaign, 'participantStudentIds'), false);
  assert.equal(Object.hasOwn(first.assignment, 'frequencyReservationId'), false);
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
  assert.equal(reservation.hasReason, true);
  assert.equal(Object.hasOwn(reservation, 'reason'), false);
  const storedReservation = store.snapshot().frequencyReservations.find((candidate) => candidate.id === reservation.id);
  assert.ok(storedReservation.reasonCiphertext);
  assert.equal(Object.hasOwn(storedReservation, 'reason'), false);
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
  const student = authFor(store.snapshot(), 'student-demo');
  const started = await beginAttempt(store, student, store.snapshot().assignments.find((assignment) => assignment.campaignId === campaign.id).id);
  assert.equal(Object.hasOwn(started.attempt, 'tenantId'), false);
  assert.equal(Object.hasOwn(started.attempt, 'studentId'), false);
  assert.equal(Object.hasOwn(started.attempt, 'scaleVersionId'), false);
  await saveAnswers(store, student, started.attempt.id, { expectedRevision: 0, answers: { q1: 1 } });
  await store.transaction((state) => { state.campaigns.find((candidate) => candidate.id === campaign.id).closesAt = '2020-01-01T00:00:00.000Z'; });
  const staleTasks = await listMyTasks(store, student);
  assert.equal(staleTasks[0].available, false);
  assert.equal(staleTasks[0].availabilityReason, 'outside_window');
  await assert.rejects(() => saveAnswers(store, student, started.attempt.id, { expectedRevision: 1, answers: { q1: 0 } }), (error) => error.code === 'CAMPAIGN_CLOSED');
  await updateCampaignState(store, admin, campaign.id, 'closed');
  assert.equal(store.snapshot().assignments[0].status, 'expired');
  assert.equal(store.snapshot().frequencyReservations[0].status, 'released');
});

test('declined or completed assignments cannot be reopened after their session is closed', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const student = await store.read((state) => state.users.find((user) => user.id === DEMO_IDS.student));
  assert.ok(student);
  const auth = { user: student, session: { tokenHash: 'synthetic', userId: student.id, tenantId: student.tenantId, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() } };
  await store.transaction((state) => { state.students.find((candidate) => candidate.id === DEMO_IDS.student).age = 10; });
  const ageRestrictedTasks = await listMyTasks(store, auth);
  assert.equal(ageRestrictedTasks[0].available, false);
  assert.equal(ageRestrictedTasks[0].availabilityReason, 'age_not_allowed');
  await store.transaction((state) => { state.students.find((candidate) => candidate.id === DEMO_IDS.student).age = 15; });
  await store.transaction((state) => { state.assignments.find((assignment) => assignment.id === DEMO_IDS.assignment).status = 'declined'; });
  await assert.rejects(() => beginAttempt(store, auth, DEMO_IDS.assignment), (error) => error.code === 'ASSIGNMENT_NOT_AVAILABLE');
  await store.transaction((state) => {
    state.assignments.find((assignment) => assignment.id === DEMO_IDS.assignment).status = 'assigned';
    state.frequencyReservations.find((reservation) => reservation.id === 'frequency-demo').status = 'released';
  });
  await assert.rejects(() => beginAttempt(store, auth, DEMO_IDS.assignment), (error) => error.code === 'FREQUENCY_REVIEW_REQUIRED');
});

test('task availability and self-service catalog hide revoked or expired scales', async () => {
  const state = seedDemoState();
  const store = new JsonStore({ initial: state });
  const student = authFor(store.snapshot(), DEMO_IDS.student);
  await store.transaction((draft) => {
    const scale = draft.scales.find((candidate) => candidate.id === DEMO_IDS.scale);
    scale.status = 'revoked';
  });
  const revokedTasks = await listMyTasks(store, student);
  assert.equal(revokedTasks[0].available, false);
  assert.equal(revokedTasks[0].availabilityReason, 'scale_unavailable');
  assert.deepEqual(await listAvailableScales(store, student), []);

  await store.transaction((draft) => {
    const scale = draft.scales.find((candidate) => candidate.id === DEMO_IDS.scale);
    scale.status = 'approved';
    scale.provenance = 'licensed';
    scale.licenseExpiresAt = '2020-01-01T00:00:00.000Z';
  });
  const expiredTasks = await listMyTasks(store, student);
  assert.equal(expiredTasks[0].available, false);
  assert.equal(expiredTasks[0].availabilityReason, 'scale_unavailable');
  assert.deepEqual(await listAvailableScales(store, student), []);
});

test('scale catalog is metadata-only and supports governed suitability filters', async () => {
  const state = seedDemoState();
  state.scales.push({
    ...state.scales[0],
    id: 'scale-synthetic-primary-draft',
    code: 'SYNTH-PRIMARY',
    title: '合成小学支持草稿',
    version: '0.1.0',
    status: 'draft',
    minAge: 9,
    maxAge: 11,
    population: 'primary',
    items: [{ id: 'q1', prompt: '不应出现在目录卡片中的合成题', min: 0, max: 1, reverse: false, factor: 'support' }],
  });
  const store = new JsonStore({ initial: state });
  const admin = authFor(store.snapshot(), 'user-admin-demo');
  const catalog = await listScaleCatalog(store, admin);
  assert.equal(catalog.length, 2);
  assert.equal(Object.hasOwn(catalog[0], 'items'), false);
  assert.equal(catalog.find((scale) => scale.id === DEMO_IDS.scale).licenseState, 'synthetic_only');
  const primaryDraft = await listScaleCatalog(store, admin, { status: 'draft', population: 'primary', minAge: 10, maxAge: 11 });
  assert.deepEqual(primaryDraft.map((scale) => scale.id), ['scale-synthetic-primary-draft']);
  await assert.rejects(() => listScaleCatalog(store, admin, { status: 'published' }), (error) => error.code === 'SCALE_FILTER_INVALID');
  await assert.rejects(() => listScaleCatalog(store, admin, { minAge: 19, maxAge: 6 }), (error) => error.code === 'SCALE_FILTER_INVALID');
  const corrupted = seedDemoState();
  corrupted.scales[0].provenance = 'licensed';
  corrupted.scales[0].licenseExpiresAt = 'not-a-date';
  const corruptedCatalog = await listScaleCatalog(new JsonStore({ initial: corrupted }), admin);
  assert.equal(corruptedCatalog[0].licenseState, 'invalid_expiry');
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
  await assert.rejects(() => createScale(store, author, { code: 'SYNTH-LONG', title: 'x'.repeat(201), version: '1.0.0', provenance: 'synthetic_only', minAge: 12, maxAge: 18, scoringVersion: 'synthetic-v1', noticeVersion: 'notice-demo-v1', items: [{ id: 'q1', prompt: '合成题', min: 0, max: 1, reverse: false, factor: 'factor' }] }), (error) => error.code === 'SCALE_INVALID');
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
