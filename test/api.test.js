import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../dist/apps/api/src/main.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState, DEMO_PASSWORD, DEMO_IDS } from '../dist/apps/api/src/domain/seed.js';
import { drainOutbox } from '../dist/apps/api/src/domain/service.js';

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
});
