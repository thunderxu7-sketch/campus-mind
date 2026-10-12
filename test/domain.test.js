import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acknowledgeCase, addFollowUp, approveClosure, approveFrequencyException, approveScale, assignCase, beginAttempt, createAvailabilitySlot, createCampaign, createConsent, createRiskSignal, createScale, createSelfScreening, drainOutbox, getCaseBriefing, getMyConsentContext, listAvailableScales, listAppointments, listAvailabilitySlots, listCases, listMyTasks, listScaleCatalog, listStudents, listProfessionalDirectory, publishCampaign, requestAppointment, requestClosure, rescheduleAppointment, reviewCase, revokeScale, saveAnswers, updateAppointment, updateCampaignState, withdrawConsent, verifyGuardianLink } from '../dist/apps/api/src/domain/service.js';
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

test('appointments support counselor-scoped calendars, rescheduling and mutual reminders', async () => {
  const delivered = [];
  const store = new JsonStore({ initial: seedDemoState(), notificationDispatcher: { async deliver(input) { delivered.push(input); return { status: 'sent', provider: 'synthetic-test' }; } } });
  const snapshot = store.snapshot();
  const admin = authFor(snapshot, 'user-professional-demo');
  const counselor = authFor(snapshot, 'user-counselor-demo');
  const student = authFor(snapshot, 'student-demo');
  const timeAt = (hours, durationMinutes = 60) => ({ startsAt: new Date(Date.now() + hours * 3_600_000).toISOString(), endsAt: new Date(Date.now() + hours * 3_600_000 + durationMinutes * 60_000).toISOString() });
  const firstWindow = timeAt(10);
  const nextWindow = timeAt(36);
  const overlappingWindow = timeAt(10);
  const otherWindow = timeAt(14);
  await assert.rejects(() => createAvailabilitySlot(store, admin, { counselorId: 'user-counselor-demo', startsAt: '2030-01-01T10:00', endsAt: '2030-01-01T11:00' }), (error) => error.code === 'SLOT_INVALID');
  const first = await createAvailabilitySlot(store, admin, { counselorId: 'user-counselor-demo', ...firstWindow, room: '合成咨询室 A' });
  const next = await createAvailabilitySlot(store, admin, { counselorId: 'user-counselor-demo', ...nextWindow, room: '合成咨询室 A' });
  const overlapping = await createAvailabilitySlot(store, admin, { counselorId: 'user-professional-demo', ...overlappingWindow, room: '合成咨询室 B' });
  const other = await createAvailabilitySlot(store, admin, { counselorId: 'user-professional-demo', ...otherWindow, room: '合成咨询室 B' });
  const counselorOwnedSlot = await createAvailabilitySlot(store, counselor, { counselorId: 'user-counselor-demo', ...timeAt(18) });
  assert.equal(counselorOwnedSlot.counselorId, 'user-counselor-demo');
  await assert.rejects(() => createAvailabilitySlot(store, counselor, { counselorId: 'user-professional-demo', ...timeAt(20) }), (error) => error.code === 'SLOT_INVALID');
  const counselorSlots = await listAvailabilitySlots(store, counselor);
  assert.ok(counselorSlots.some((slot) => slot.id === first.id));
  assert.equal(counselorSlots.some((slot) => slot.id === other.id), false, 'counselor sees only their own slots');
  assert.equal((await listAvailabilitySlots(store, student, { room: '咨询室 A' })).length, 2);
  await assert.rejects(() => listAvailabilitySlots(store, student, { startsFrom: '2030-01-01T00:00' }), (error) => error.code === 'SLOT_FILTER_INVALID');

  const appointment = await requestAppointment(store, student, { slotId: first.id, idempotencyKey: 'synthetic-calendar-001' });
  await assert.rejects(() => rescheduleAppointment(store, counselor, appointment.id, other.id), (error) => error.code === 'FORBIDDEN');
  await assert.rejects(() => requestAppointment(store, student, { slotId: overlapping.id }), (error) => error.code === 'APPOINTMENT_CONFLICT');
  await drainOutbox(store, 5);
  assert.deepEqual(delivered[0].recipientIds.sort(), ['student-demo', 'user-counselor-demo']);
  await updateAppointment(store, counselor, appointment.id, 'confirmed');
  const reminders = store.snapshot().outboxEvents.filter((event) => event.aggregateId === appointment.id && event.type === 'appointment.reminder_due' && event.status === 'pending');
  assert.deepEqual(reminders.map((event) => event.payload.reminderMinutes).sort((a, b) => a - b), [15, 60], 'already-passed reminder offsets are skipped');
  assert.equal((await listAppointments(store, counselor)).some((item) => item.id === appointment.id), true);
  await drainOutbox(store, 5);
  assert.deepEqual(delivered[1].recipientIds.sort(), ['student-demo', 'user-counselor-demo']);
  assert.equal(delivered[1].context.state, 'confirmed');
  assert.equal(Object.hasOwn(delivered[1].context, 'note'), false, 'private appointment notes never reach the notification adapter');

  await rescheduleAppointment(store, student, appointment.id, next.id);
  const rescheduleEventCount = store.snapshot().outboxEvents.filter((event) => event.aggregateId === appointment.id && event.type === 'appointment.rescheduled').length;
  await rescheduleAppointment(store, student, appointment.id, next.id);
  assert.equal(store.snapshot().outboxEvents.filter((event) => event.aggregateId === appointment.id && event.type === 'appointment.rescheduled').length, rescheduleEventCount, 'retrying the same reschedule does not duplicate notices');
  const rescheduled = store.snapshot();
  const changed = rescheduled.appointments.find((item) => item.id === appointment.id);
  assert.equal(changed.state, 'requested', 'a changed time must be confirmed again');
  assert.equal(changed.slotId, next.id);
  assert.equal(rescheduled.availabilitySlots.find((item) => item.id === first.id).status, 'available');
  assert.ok(rescheduled.outboxEvents.filter((event) => event.aggregateId === appointment.id && event.type === 'appointment.reminder_due').every((event) => event.status === 'cancelled'));
  await drainOutbox(store, 5);
  assert.equal(delivered.some((item) => item.eventType === 'appointment.rescheduled'), true);
  await updateAppointment(store, counselor, appointment.id, 'confirmed');
  const allReminders = store.snapshot().outboxEvents.filter((event) => event.aggregateId === appointment.id && event.type === 'appointment.reminder_due' && event.status === 'pending');
  assert.deepEqual(allReminders.map((event) => event.payload.reminderMinutes).sort((a, b) => a - b), [15, 60, 1440], 'all future reminder offsets are queued for the rescheduled time');
  await assert.rejects(() => updateAppointment(store, counselor, appointment.id, 'no_show'), (error) => error.code === 'APPOINTMENT_NOT_ENDED');
  await store.transaction((state) => {
    const slot = state.availabilitySlots.find((item) => item.id === next.id);
    slot.startsAt = new Date(Date.now() - 2 * 60_000).toISOString();
    slot.endsAt = new Date(Date.now() - 60_000).toISOString();
  });
  assert.equal((await updateAppointment(store, counselor, appointment.id, 'no_show')).state, 'no_show');
  await drainOutbox(store, 5);
  assert.ok(delivered.some((item) => item.eventType === 'appointment.no_show' && item.recipientIds.includes('student-demo')));

  const otherAppointment = await requestAppointment(store, student, { slotId: other.id });
  assert.equal((await listAppointments(store, counselor)).some((item) => item.id === otherAppointment.id), false, 'counselor cannot see another counselor\'s appointment');
  await assert.rejects(() => updateAppointment(store, counselor, otherAppointment.id, 'confirmed'), (error) => error.code === 'FORBIDDEN');
});

test('appointment notification failures appear in the scoped exception queue', async () => {
  const store = new JsonStore({ initial: seedDemoState(), notificationDispatcher: { async deliver() { return { status: 'failed', provider: 'synthetic-test', errorCode: 'TEST_DELIVERY_FAILED' }; } } });
  const state = store.snapshot();
  const manager = authFor(state, 'user-professional-demo');
  const student = authFor(state, 'student-demo');
  const window = { startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 4_200_000).toISOString() };
  const slot = await createAvailabilitySlot(store, manager, { counselorId: 'user-counselor-demo', ...window });
  const appointment = await requestAppointment(store, student, { slotId: slot.id });
  const result = await drainOutbox(store, 1);
  assert.equal(result.failed, 1);
  await store.transaction((state) => {
    const record = state.appointments.find((item) => item.id === appointment.id);
    record.updatedAt = new Date(Date.now() - 20 * 24 * 3_600_000).toISOString();
  });
  const records = await listAppointments(store, student);
  assert.equal(records.find((item) => item.id === appointment.id).notificationIssue, 'retrying');
  assert.equal(records.find((item) => item.id === appointment.id).confirmationOverdue, true);
  assert.equal((await listAppointments(store, student, { exceptionOnly: true })).length, 1);
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

test('consent is purpose-specific, task-scoped, age-aware and guardian-verification-aware', async () => {
  const state = seedDemoState();
  const student = state.students.find((candidate) => candidate.id === DEMO_IDS.student);
  student.age = 13;
  student.guardianVerified = false;
  const store = new JsonStore({ initial: state });
  const studentAuth = authFor(store.snapshot(), DEMO_IDS.student);
  const guardianAuth = authFor(store.snapshot(), 'user-guardian-demo');
  const adminAuth = authFor(store.snapshot(), 'user-admin-demo');

  const beforeVerification = await getMyConsentContext(store, studentAuth);
  assert.equal(beforeVerification.ageBand, 'under_14');
  assert.equal(beforeVerification.guardianConsentRequired, true);
  assert.equal(beforeVerification.guardianVerificationStatus, 'pending');
  await assert.rejects(() => createConsent(store, studentAuth, { studentId: DEMO_IDS.student, actorType: 'student', noticeVersion: 'notice-demo-v1', purpose: 'assessment' }), (error) => error.code === 'GUARDIAN_CONSENT_REQUIRED');

  await verifyGuardianLink(store, adminAuth, 'guardian-link-demo');
  const guardianContext = await getMyConsentContext(store, guardianAuth);
  assert.equal(guardianContext.role, 'guardian');
  assert.equal(guardianContext.linkedStudents.length, 1);
  assert.equal(guardianContext.linkedStudents[0].guardianVerificationStatus, 'verified');
  assert.ok(Array.isArray(guardianContext.linkedStudents[0].assessmentTasks));
  assert.equal(Object.hasOwn(guardianContext.linkedStudents[0], 'reports'), false);
  assert.equal(Object.hasOwn(guardianContext.linkedStudents[0], 'answers'), false);

  const guardianConsent = await createConsent(store, guardianAuth, { studentId: DEMO_IDS.student, actorType: 'guardian', noticeVersion: 'notice-demo-v1', purpose: 'assessment' });
  assert.equal(guardianConsent.actorType, 'guardian');
  const tasksAfterConsent = await listMyTasks(store, studentAuth);
  assert.equal(tasksAfterConsent[0].available, true);
  assert.equal(tasksAfterConsent[0].guardianVerificationStatus, 'verified');

  const expressionConsent = await createConsent(store, guardianAuth, { studentId: DEMO_IDS.student, actorType: 'guardian', noticeVersion: 'expression-demo-v1', purpose: 'self_expression' });
  assert.equal(expressionConsent.purpose, 'self_expression');
  assert.equal(store.snapshot().consents.find((record) => record.id === guardianConsent.id).status, 'active', 'separate-purpose consent must not replace assessment participation');
  await withdrawConsent(store, studentAuth, expressionConsent.id);
  const history = await getMyConsentContext(store, studentAuth);
  assert.equal(history.consentHistory.find((record) => record.id === expressionConsent.id).status, 'withdrawn');
  assert.equal(history.consentHistory.find((record) => record.id === guardianConsent.id).status, 'active');
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
  assert.equal(staleTasks[0].nextAction, 'wait_for_window');
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

test('scale item ranges stay within the student control rendering bound', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const author = authFor(store.snapshot(), 'user-professional-demo');
  const accepted = await createScale(store, author, { code: 'SYNTH-RANGE-03', title: '合成三点评分方案', version: '1.0.0', provenance: 'synthetic_only', minAge: 12, maxAge: 18, scoringVersion: 'synthetic-range-v1', noticeVersion: 'notice-demo-v1', items: [{ id: 'q1', prompt: '合成三点评分题', min: 0, max: 3, reverse: false, factor: 'factor' }] });
  assert.equal(accepted.items[0].max, 3);
  await assert.rejects(() => createScale(store, author, { code: 'SYNTH-RANGE-TOO-WIDE', title: '合成超宽评分方案', version: '1.0.0', provenance: 'synthetic_only', minAge: 12, maxAge: 18, scoringVersion: 'synthetic-range-wide-v1', noticeVersion: 'notice-demo-v1', items: [{ id: 'q1', prompt: '合成超宽评分题', min: 0, max: 21, reverse: false, factor: 'factor' }] }), (error) => error.code === 'SCALE_INVALID');
});

test('counselor object scope rejects unassigned students and cases', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const lead = authFor(store.snapshot(), 'user-professional-demo');
  const counselor = authFor(store.snapshot(), 'user-counselor-demo');
  const riskCase = await createRiskSignal(store, lead, { studentId: DEMO_IDS.student, level: 'attention', source: 'staff_observation', reason: '合成测试：负责人创建待分配线索' });
  assert.deepEqual(await listStudents(store, counselor), []);
  await assert.rejects(() => createRiskSignal(store, counselor, { studentId: DEMO_IDS.student, level: 'attention', reason: '合成测试：咨询师越权线索' }), (error) => error.code === 'NOT_FOUND');
  await reviewCase(store, lead, riskCase.id, { decision: 'confirm', note: '合成测试：负责人完成初步复核。' });
  await assignCase(store, lead, riskCase.id, 'user-professional-demo');
  await acknowledgeCase(store, lead, riskCase.id);
  await assert.rejects(() => addFollowUp(store, counselor, riskCase.id, { kind: 'follow_up', note: '合成测试：未授权随访。' }), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(() => requestClosure(store, counselor, riskCase.id, '合成测试：未授权结案申请。'), (error) => error.code === 'NOT_FOUND');
});

test('case workflow exposes stage ownership, deadlines, exceptions, and minimum context only', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const lead = authFor(store.snapshot(), 'user-professional-demo');
  const counselor = authFor(store.snapshot(), 'user-counselor-demo');
  const riskCase = await createRiskSignal(store, lead, { studentId: DEMO_IDS.student, level: 'attention', source: 'staff_observation', reason: '合成测试：仅用于工作流异常队列验证。' });

  const reviewBrief = await getCaseBriefing(store, lead, riskCase.id);
  assert.equal(reviewBrief.linkedSignalCount, 1);
  assert.equal(Object.hasOwn(reviewBrief, 'reason'), false);
  assert.equal(Object.hasOwn(reviewBrief, 'answers'), false);
  assert.equal(Object.hasOwn(reviewBrief, 'notes'), false);
  await assert.rejects(() => getCaseBriefing(store, counselor, riskCase.id), (error) => error.code === 'NOT_FOUND');

  await reviewCase(store, lead, riskCase.id, { decision: 'confirm', note: '合成测试：确认后进入待指派队列。' });
  const unassignedCase = (await listCases(store, lead)).find((record) => record.id === riskCase.id);
  assert.equal(unassignedCase.lane, 'pending_assignment');
  assert.equal(unassignedCase.nextOwner, '专业负责人（待指派）');
  assert.ok(unassignedCase.exceptionReasons.includes('unassigned'));

  await assignCase(store, lead, riskCase.id, 'user-counselor-demo');
  const assignedBrief = await getCaseBriefing(store, counselor, riskCase.id);
  assert.equal(assignedBrief.acknowledgement.pending, true);
  await store.transaction((state) => {
    const record = state.riskCases.find((candidate) => candidate.id === riskCase.id);
    record.updatedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    const event = state.outboxEvents.find((candidate) => candidate.aggregateId === riskCase.id && candidate.type === 'risk.signal_created');
    event.status = 'dead_letter';
    state.deliveryAttempts.push({ id: 'synthetic-case-delivery-failure', tenantId: record.tenantId, outboxEventId: event.id, channel: 'in_app', status: 'failed', attemptedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(), errorCode: 'SYNTHETIC_FAILURE' });
  });
  const assigned = (await listCases(store, lead)).find((record) => record.id === riskCase.id);
  assert.equal(assigned.lane, 'pending_acknowledgement');
  assert.equal(assigned.nextOwner, '演示心理咨询师');
  assert.equal(assigned.overdue, true);
  assert.ok(assigned.waitingMinutes >= 0);
  assert.ok(assigned.exceptionReasons.includes('not_accepted'));
  assert.ok(assigned.exceptionReasons.includes('notification_failed'));
  assert.ok(assigned.exceptionReasons.includes('deadline_overdue'));
  await store.transaction((state) => {
    const record = state.riskCases.find((candidate) => candidate.id === riskCase.id);
    record.state = 'closure_requested';
    delete record.closureRequestedBy;
  });
  await assert.rejects(() => reviewCase(store, lead, riskCase.id, { decision: 'confirm', note: '合成测试：不能绕过独立结案审核。' }), (error) => error.code === 'CASE_STATE_INVALID');
  await assert.rejects(() => approveClosure(store, lead, riskCase.id), (error) => error.code === 'SEPARATION_OF_DUTIES_REQUIRED');
});

test('staff pickers search names/classes and return only purpose-scoped directories', async () => {
  const store = new JsonStore({ initial: seedDemoState() });
  const snapshot = store.snapshot();
  const admin = authFor(snapshot, 'user-admin-demo');
  const lead = authFor(snapshot, 'user-professional-demo');
  const counselor = authFor(snapshot, 'user-counselor-demo');
  const teacher = authFor(snapshot, 'user-teacher-demo');

  assert.deepEqual(await listStudents(store, admin), [], 'the directory must not enumerate students without a query');
  const byName = await listStudents(store, admin, { search: '演示学生' });
  assert.deepEqual(byName.map(({ displayName, classId }) => ({ displayName, classId })), [{ displayName: '演示学生', classId: 'class-demo-1' }]);
  assert.deepEqual((await listStudents(store, admin, { grade: '高一' })).map((row) => row.id), [DEMO_IDS.student]);
  assert.deepEqual(await listStudents(store, admin, { search: 'class-demo-1' }).then((rows) => rows.map((row) => row.id)), [DEMO_IDS.student]);
  await assert.rejects(() => listStudents(store, teacher, { search: '演示学生' }), (error) => error.code === 'FORBIDDEN');

  const professionals = await listProfessionalDirectory(store, admin, 'appointment');
  assert.deepEqual(professionals.map((person) => person.id), ['user-counselor-demo']);
  await assert.rejects(() => listProfessionalDirectory(store, counselor, 'case_assignment'), (error) => error.code === 'FORBIDDEN');
  const assignees = await listProfessionalDirectory(store, lead, 'case_assignment');
  assert.deepEqual(assignees.map((person) => person.id).sort(), ['user-counselor-demo', 'user-professional-demo']);
  await createRiskSignal(store, lead, { studentId: DEMO_IDS.student, level: 'attention', source: 'staff_observation', reason: '合成测试：年级过滤元数据' });
  assert.equal((await listCases(store, lead))[0].grade, '高一');
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
