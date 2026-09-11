import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../dist/apps/api/src/main.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState, DEMO_PASSWORD, DEMO_IDS } from '../dist/apps/api/src/domain/seed.js';
import { createCampaign, drainOutbox, publishCampaign } from '../dist/apps/api/src/domain/service.js';

process.env.CAMPMIND_DEMO_MFA = 'true';
process.env.CAMPMIND_MASTER_KEY = 'test-master-key-never-use-in-production';

let server;
let base;
let store;

before(async () => {
  store = new JsonStore({ initial: seedDemoState() });
  server = createApp({ store });
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

async function request(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function login(email) {
  const { response, body } = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.token;
}

function auth(token) { return { authorization: `Bearer ${token}` }; }


test('health and browser surfaces expose safety headers', async () => {
  const { response, body } = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const page = await fetch(base + '/student');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /不是诊断/);
});

test('admin MFA is enforced unless demo override is explicitly enabled', async () => {
  const previous = process.env.CAMPMIND_DEMO_MFA;
  process.env.CAMPMIND_DEMO_MFA = 'false';
  const { response, body } = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@campus-mind.demo', password: DEMO_PASSWORD }) });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'MFA_REQUIRED');
  process.env.CAMPMIND_DEMO_MFA = previous;
});

test('student assessment lifecycle is durable, revision-safe and idempotent', async () => {
  const token = await login('student@campus-mind.demo');
  const tasks = await request('/v1/me/tasks', { headers: auth(token) });
  assert.equal(tasks.response.status, 200);
  assert.equal(tasks.body.data.length, 1);
  const assignmentId = tasks.body.data[0].id;
  const started = await request(`/v1/me/tasks/${assignmentId}/attempts`, { method: 'POST', headers: auth(token), body: '{}' });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const attemptId = started.body.data.attempt.id;
  const scale = started.body.data.scale;
  const saved = await request(`/v1/attempts/${attemptId}/answers`, { method: 'PUT', headers: auth(token), body: JSON.stringify({ expectedRevision: 0, answers: { q1: 1 } }) });
  assert.equal(saved.response.status, 200);
  const conflict = await request(`/v1/attempts/${attemptId}/answers`, { method: 'PUT', headers: auth(token), body: JSON.stringify({ expectedRevision: 0, answers: { q1: 0 } }) });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
  const answers = Object.fromEntries(scale.items.map((item) => [item.id, 1]));
  const full = await request(`/v1/attempts/${attemptId}/answers`, { method: 'PUT', headers: auth(token), body: JSON.stringify({ expectedRevision: saved.body.data.revision, answers }) });
  assert.equal(full.response.status, 200);
  const key = 'assessment-submit-test-001';
  const submitted = await request(`/v1/attempts/${attemptId}/submit`, { method: 'POST', headers: auth(token), body: JSON.stringify({ idempotencyKey: key }) });
  assert.equal(submitted.response.status, 202);
  assert.equal(submitted.body.data.state, 'scoring_pending');
  const retry = await request(`/v1/attempts/${attemptId}/submit`, { method: 'POST', headers: auth(token), body: JSON.stringify({ idempotencyKey: key }) });
  assert.equal(retry.response.status, 202);
  assert.equal(retry.body.data.submissionId, submitted.body.data.submissionId);
  const mismatch = await request(`/v1/attempts/${attemptId}/submit`, { method: 'POST', headers: auth(token), body: JSON.stringify({ idempotencyKey: 'another-submit-key-001' }) });
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const drained = await drainOutbox(store);
  assert.ok(drained.processed >= 1);
  assert.ok(store.snapshot().deliveryAttempts.some((attempt) => attempt.channel === 'in_app' && attempt.status === 'sent'));
  assert.equal(store.snapshot().assignments.find((assignment) => assignment.id === assignmentId).status, 'completed');
  const reports = await request('/v1/reports', { headers: auth(token) });
  assert.equal(reports.response.status, 200);
  assert.equal(reports.body.data.length, 0, 'pending report must not be visible to a student');
});

test('professional review, assignment, acknowledgement and independent closure work', async () => {
  const professional = await login('professional@campus-mind.demo');
  const counselor = await login('counselor@campus-mind.demo');
  const cases = await request('/v1/cases', { headers: auth(professional) });
  assert.equal(cases.response.status, 200);
  assert.equal(cases.body.data.length, 1);
  const caseId = cases.body.data[0].id;
  const review = await request(`/v1/cases/${caseId}/reviews`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ decision: 'confirm', note: '合成演示：需要专业人员进一步了解，非诊断结论。' }) });
  assert.equal(review.response.status, 200);
  const assign = await request(`/v1/cases/${caseId}/assign`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ assigneeId: 'user-counselor-demo' }) });
  assert.equal(assign.response.status, 200);
  const ack = await request(`/v1/cases/${caseId}/acknowledgements`, { method: 'POST', headers: auth(counselor), body: '{}' });
  assert.equal(ack.response.status, 201);
  const follow = await request(`/v1/cases/${caseId}/follow-ups`, { method: 'POST', headers: auth(counselor), body: JSON.stringify({ kind: 'support', note: '合成支持记录；下一次随访待定。' }) });
  assert.equal(follow.response.status, 201);
  const closure = await request(`/v1/cases/${caseId}/closure-requests`, { method: 'POST', headers: auth(counselor), body: JSON.stringify({ reason: '合成随访已记录，申请独立复核。' }) });
  assert.equal(closure.response.status, 200);
  const approved = await request(`/v1/cases/${caseId}/closure-approvals`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.state, 'closed');
});

test('report release controls student visibility and service errors do not leak data', async () => {
  const professional = await login('professional@campus-mind.demo');
  const reports = await request('/v1/reports?studentId=student-demo', { headers: auth(professional) });
  assert.equal(reports.response.status, 200);
  assert.equal(reports.body.data.length, 1);
  const reportId = reports.body.data[0].id;
  const released = await request(`/v1/reports/${reportId}/release`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(released.response.status, 204);
  const student = await login('student@campus-mind.demo');
  const visible = await request('/v1/reports', { headers: auth(student) });
  assert.equal(visible.response.status, 200);
  assert.equal(visible.body.data.length, 1);
  assert.match(visible.body.data[0].summary.text, /不构成心理诊断/);
  const unauthorized = await request('/v1/reports/does-not-exist', { headers: auth(student) });
  assert.equal(unauthorized.response.status, 404);
  assert.deepEqual(Object.keys(unauthorized.body.error).sort(), ['code', 'message']);
});


test('imports, governed schemas, aggregate analytics, exports and public content are controlled', async () => {
  const admin = await login('admin@campus-mind.demo');
  const professional = await login('professional@campus-mind.demo');
  const preview = await request('/v1/imports/preview', { method: 'POST', headers: auth(admin), body: JSON.stringify({ schoolId: 'school-demo', filename: 'synthetic-students.csv', rows: [{ externalId: 'synthetic-new-001', displayName: '合成学生甲', age: 14, classId: 'class-demo-1', guardianVerified: false }, { externalId: '', displayName: '缺失编号', age: 14, classId: 'class-demo-1' }] }) });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.body));
  assert.equal(preview.body.data.batch.validRowCount, 1);
  const committed = await request(`/v1/imports/${preview.body.data.batch.id}/commit`, { method: 'POST', headers: auth(admin), body: JSON.stringify({ rows: [{ externalId: 'synthetic-new-001', displayName: '合成学生甲', age: 14, classId: 'class-demo-1', guardianVerified: false }, { externalId: '', displayName: '缺失编号', age: 14, classId: 'class-demo-1' }] }) });
  assert.equal(committed.response.status, 200);
  const schema = await request('/v1/profile-schemas', { method: 'POST', headers: auth(professional), body: JSON.stringify({ version: 'demo-v1', fields: [{ id: 'sleep', label: '睡眠情况', purpose: '合成演示字段', required: false, sensitive: true }] }) });
  assert.equal(schema.response.status, 201);
  const schemaApproved = await request(`/v1/profile-schemas/${schema.body.data.id}/approve`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(schemaApproved.response.status, 200);
  const student = await login('student@campus-mind.demo');
  const profileResponse = await request('/v1/me/profile-responses', { method: 'POST', headers: auth(student), body: JSON.stringify({ schemaId: schema.body.data.id, values: { sleep: '合成：大致规律' } }) });
  assert.equal(profileResponse.response.status, 201);
  const analytics = await request('/v1/analytics/summary?groupBy=school', { headers: auth(professional) });
  assert.equal(analytics.response.status, 200);
  assert.equal(analytics.body.data.rows[0].suppressed, true);
  const exportRequest = await request('/v1/exports', { method: 'POST', headers: auth(admin), body: JSON.stringify({ kind: 'aggregate' }) });
  assert.equal(exportRequest.response.status, 201);
  const exportApprove = await request(`/v1/exports/${exportRequest.body.data.id}/approve`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(exportApprove.response.status, 200);
  const exportDownload = await request(`/v1/exports/${exportRequest.body.data.id}`, { headers: auth(admin) });
  assert.equal(exportDownload.response.status, 200);
  assert.equal(exportDownload.body.data.suppressionThreshold, 10);
  const slot = await request('/v1/availability-slots', { method: 'POST', headers: auth(professional), body: JSON.stringify({ counselorId: 'user-counselor-demo', startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString(), room: '合成咨询室' }) });
  assert.equal(slot.response.status, 201);
  const appointment = await request('/v1/appointments', { method: 'POST', headers: auth(student), body: JSON.stringify({ slotId: slot.body.data.id, note: '合成预约说明' }) });
  assert.equal(appointment.response.status, 201);
  const confirmed = await request(`/v1/appointments/${appointment.body.data.id}/state`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ state: 'confirmed' }) });
  assert.equal(confirmed.response.status, 200);
  const content = await request('/v1/content', { method: 'POST', headers: auth(professional), body: JSON.stringify({ title: '如何找到可信任的支持', kind: 'article', body: '合成教育内容：可以向可信任的成人或专业老师表达需要。', ageMin: 12, ageMax: 18, copyrightSource: 'synthetic-only' }) });
  assert.equal(content.response.status, 201);
  const published = await request(`/v1/content/${content.body.data.id}/publish`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(published.response.status, 200);
  const publicContent = await request('/v1/content/public?age=15');
  assert.equal(publicContent.response.status, 200);
  assert.ok(publicContent.body.data.some((item) => item.id === content.body.data.id));
});


test('teacher progress is limited to operational counts', async () => {
  const teacher = await login('teacher@campus-mind.demo');
  const progress = await request('/v1/campaigns/campaign-demo/progress', { headers: auth(teacher) });
  assert.equal(progress.response.status, 200);
  assert.equal(progress.body.data.completed, 1);
  assert.match(progress.body.data.note, /不包含分数/);
  assert.equal(Object.hasOwn(progress.body.data, 'studentIds'), false);
});

test('rights requests are auditable and privacy staff can complete non-destructive access requests', async () => {
  const student = await login('student@campus-mind.demo');
  const privacy = await login('privacy@campus-mind.demo');
  const created = await request('/v1/rights-requests', { method: 'POST', headers: auth(student), body: JSON.stringify({ studentId: 'student-demo', kind: 'access', reason: '合成演示查阅申请' }) });
  assert.equal(created.response.status, 201);
  const listed = await request('/v1/admin/rights-requests', { headers: auth(privacy) });
  assert.equal(listed.response.status, 200);
  const completed = await request(`/v1/admin/rights-requests/${created.body.data.id}/complete`, { method: 'POST', headers: auth(privacy), body: JSON.stringify({ decision: 'complete' }) });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.data.status, 'completed');
});

test('consent withdrawal blocks future assessment and leaves audit evidence', async () => {
  const admin = await login('admin@campus-mind.demo');
  const student = await login('student@campus-mind.demo');
  const snapshot = store.snapshot();
  const consent = snapshot.consents.find((c) => c.studentId === DEMO_IDS.student && c.status === 'active');
  assert.ok(consent);
  const withdrawn = await request(`/v1/me/consents/${consent.id}/withdraw`, { method: 'POST', headers: auth(student), body: '{}' });
  assert.equal(withdrawn.response.status, 204);
  const task = await request('/v1/me/tasks', { headers: auth(student) });
  assert.equal(task.response.status, 200);
  const attempt = await request(`/v1/me/tasks/${DEMO_IDS.assignment}/attempts`, { method: 'POST', headers: auth(student), body: '{}' });
  assert.equal(attempt.response.status, 400);
  assert.equal(attempt.body.error.code, 'CONSENT_REQUIRED');
  const audit = await request('/v1/admin/audit', { headers: auth(admin) });
  assert.equal(audit.response.status, 403, 'school admin cannot read sensitive audit by default');
  assert.ok(store.snapshot().auditEvents.some((e) => e.action === 'consent.withdrawn'));
  const ops = await login('ops@campus-mind.demo');
  const drained = await request('/v1/admin/worker/drain', { method: 'POST', headers: auth(ops), body: '{}' });
  assert.equal(drained.response.status, 200);
});
