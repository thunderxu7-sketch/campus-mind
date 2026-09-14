import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../dist/apps/api/src/main.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState, DEMO_PASSWORD } from '../dist/apps/api/src/domain/seed.js';
import { drainOutbox } from '../dist/apps/api/src/domain/service.js';

process.env.CAMPMIND_MASTER_KEY = 'test-master-key-never-use-in-production';
process.env.CAMPMIND_DEMO_MFA = 'true';

let server;
let base;
let store;
const tokens = new Map();

before(async () => {
  store = new JsonStore({ initial: seedDemoState() });
  server = createApp({ store });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

async function request(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login(email) {
  if (tokens.has(email)) return tokens.get(email);
  const result = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  tokens.set(email, result.body.data.token);
  return result.body.data.token;
}

function auth(token, idempotencyKey) {
  return { authorization: `Bearer ${token}`, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
}

test('student expression sharing and professional support lifecycle are explicit, scoped and idempotent', async () => {
  const student = await login('student@campus-mind.demo');
  const professional = await login('counselor@campus-mind.demo');
  const teacher = await login('teacher@campus-mind.demo');

  const capabilities = await request('/v1/me/expression-capabilities', { headers: auth(student) });
  assert.equal(capabilities.response.status, 200);
  assert.equal(capabilities.body.data.expressionEnabled, true);
  assert.equal(capabilities.body.data.visualEnabled, false);
  assert.equal(capabilities.body.data.noticeVersions.selfExpression, 'expression-demo-v1');
  assert.deepEqual(capabilities.body.data.allowedShareHours, [1, 24, 168]);

  const withoutConsent = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-no-consent-0001'), body: JSON.stringify({ topic: 'study', note: '合成测试', noticeVersion: 'expression-demo-v1', acknowledged: true }) });
  assert.equal(withoutConsent.response.status, 403);
  assert.equal(withoutConsent.body.error.code, 'EXPRESSION_CONSENT_REQUIRED');
  const extraField = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-extra-field-0001'), body: JSON.stringify({ topic: 'study', note: '合成测试', noticeVersion: 'expression-demo-v1', acknowledged: true, unexpected: true }) });
  assert.equal(extraField.response.status, 400);
  assert.equal(extraField.body.error.code, 'EXPRESSION_INPUT_INVALID');
  const oversized = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-oversized-0001'), body: JSON.stringify({ note: 'x'.repeat(9000), noticeVersion: 'expression-demo-v1', acknowledged: true }) });
  assert.equal(oversized.response.status, 413);

  const consent = await request('/v1/me/consents', { method: 'POST', headers: auth(student), body: JSON.stringify({ studentId: 'student-demo', actorType: 'student', purpose: 'self_expression', noticeVersion: 'expression-demo-v1' }) });
  assert.equal(consent.response.status, 201, JSON.stringify(consent.body));
  const recipients = await request('/v1/me/support-recipients', { headers: auth(student) });
  assert.equal(recipients.response.status, 200);
  assert.ok(recipients.body.data.some((recipient) => recipient.id === 'user-counselor-demo'));

  const entryBody = { topic: 'study', note: '合成测试：最近想和可信任的人聊聊。', noticeVersion: 'expression-demo-v1', acknowledged: true };
  const entry = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-entry-key-0001'), body: JSON.stringify(entryBody) });
  assert.equal(entry.response.status, 201, JSON.stringify(entry.body));
  const retry = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-entry-key-0001'), body: JSON.stringify(entryBody) });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.data.id, entry.body.data.id);
  const conflict = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-entry-key-0001'), body: JSON.stringify({ ...entryBody, note: '不同内容' }) });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const entryList = await request('/v1/me/expression-entries', { headers: auth(student) });
  assert.equal(entryList.response.status, 200);
  assert.equal(Object.hasOwn(entryList.body.data[0], 'note'), false);
  const entryDetail = await request(`/v1/me/expression-entries/${entry.body.data.id}`, { headers: auth(student) });
  assert.equal(entryDetail.response.status, 200);
  assert.match(entryDetail.body.data.note, /可信任/);

  const share = await request(`/v1/me/expression-entries/${entry.body.data.id}/shares`, { method: 'POST', headers: auth(student, 'expr-share-key-0001'), body: JSON.stringify({ recipientId: 'user-counselor-demo', ttlHours: 24, noticeVersion: 'expression-demo-v1', acknowledged: true }) });
  assert.equal(share.response.status, 201, JSON.stringify(share.body));
  const professionalShares = await request('/v1/professional/expression-shares', { headers: auth(professional) });
  assert.equal(professionalShares.response.status, 200);
  assert.equal(professionalShares.body.data[0].studentId, 'student-demo');
  const professionalEntry = await request(`/v1/professional/expression-shares/${share.body.data.id}`, { headers: auth(professional) });
  assert.equal(professionalEntry.response.status, 200);
  assert.match(professionalEntry.body.data.note, /可信任/);

  const support = await request('/v1/me/support-requests', { method: 'POST', headers: auth(student, 'expr-support-key-0001'), body: JSON.stringify({ recipientId: 'user-counselor-demo', shareId: share.body.data.id, noticeVersion: 'expression-demo-v1', acknowledged: true }) });
  assert.equal(support.response.status, 201, JSON.stringify(support.body));
  const supportRetry = await request('/v1/me/support-requests', { method: 'POST', headers: auth(student, 'expr-support-key-0001'), body: JSON.stringify({ recipientId: 'user-counselor-demo', shareId: share.body.data.id, noticeVersion: 'expression-demo-v1', acknowledged: true }) });
  assert.equal(supportRetry.response.status, 200);
  assert.equal(supportRetry.body.data.id, support.body.data.id);
  const duplicateRecipient = await request('/v1/me/support-requests', { method: 'POST', headers: auth(student, 'expr-support-key-0003'), body: JSON.stringify({ recipientId: 'user-counselor-demo', noticeVersion: 'expression-demo-v1', acknowledged: true }) });
  assert.equal(duplicateRecipient.response.status, 409);
  assert.equal(duplicateRecipient.body.error.code, 'SUPPORT_REQUEST_ACTIVE_EXISTS');
  assert.equal(store.snapshot().riskCases.length, 0, 'support request must not create a crisis case');
  assert.equal((await drainOutbox(store)).failed, 0);

  const professionalQueue = await request('/v1/professional/support-requests', { headers: auth(professional) });
  assert.equal(professionalQueue.response.status, 200);
  assert.equal(professionalQueue.body.data[0].state, 'requested');
  const requestId = support.body.data.id;
  const acknowledged = await request(`/v1/professional/support-requests/${requestId}/transitions`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ action: 'acknowledge', expectedVersion: 1 }) });
  assert.equal(acknowledged.response.status, 200, JSON.stringify(acknowledged.body));
  const stale = await request(`/v1/professional/support-requests/${requestId}/transitions`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ action: 'start', expectedVersion: 1 }) });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'SUPPORT_VERSION_CONFLICT');
  const started = await request(`/v1/professional/support-requests/${requestId}/transitions`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ action: 'start', expectedVersion: 2 }) });
  assert.equal(started.response.status, 200);
  const noted = await request(`/v1/professional/support-requests/${requestId}/notes`, { method: 'POST', headers: auth(professional, 'support-note-key-0001'), body: JSON.stringify({ note: '合成演示：已回复并约定后续沟通。' }) });
  assert.equal(noted.response.status, 201);
  const noteRetry = await request(`/v1/professional/support-requests/${requestId}/notes`, { method: 'POST', headers: auth(professional, 'support-note-key-0001'), body: JSON.stringify({ note: '合成演示：已回复并约定后续沟通。' }) });
  assert.equal(noteRetry.response.status, 200);
  assert.equal(noteRetry.body.data.id, noted.body.data.id);
  const notes = await request(`/v1/professional/support-requests/${requestId}/notes`, { headers: auth(professional) });
  assert.equal(notes.response.status, 200);
  assert.match(notes.body.data[0].note, /已回复/);
  const completed = await request(`/v1/professional/support-requests/${requestId}/transitions`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ action: 'complete', expectedVersion: 4 }) });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));

  const teacherQueue = await request('/v1/professional/support-requests', { headers: auth(teacher) });
  assert.equal(teacherQueue.response.status, 403);
});

test('withdrawal revokes expression sharing and cancels open support requests', async () => {
  const student = await login('student@campus-mind.demo');
  const consentList = await request('/v1/me/consents?purpose=self_expression', { headers: auth(student) });
  const consent = consentList.body.data.find((candidate) => candidate.status === 'active');
  assert.ok(consent);
  // Create a second request with a fresh entry so the cancellation path is
  // independent from the completed request in the lifecycle test.
  const entry = await request('/v1/me/expression-entries', { method: 'POST', headers: auth(student, 'expr-entry-key-0002'), body: JSON.stringify({ topic: 'general', note: '合成待撤回内容', noticeVersion: consent.noticeVersion, acknowledged: true }) });
  assert.equal(entry.response.status, 201);
  const support = await request('/v1/me/support-requests', { method: 'POST', headers: auth(student, 'expr-support-key-0002'), body: JSON.stringify({ recipientId: 'user-professional-demo', noticeVersion: consent.noticeVersion, acknowledged: true }) });
  assert.equal(support.response.status, 201);
  const withdrawn = await request(`/v1/me/consents/${consent.id}/withdraw`, { method: 'POST', headers: auth(student), body: '{}' });
  assert.equal(withdrawn.response.status, 204, JSON.stringify(withdrawn.body));
  const requests = await request('/v1/me/support-requests', { headers: auth(student) });
  const cancelled = requests.body.data.find((candidate) => candidate.id === support.body.data.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'consent_withdrawn');
  const shares = await request('/v1/me/expression-shares', { headers: auth(student) });
  assert.ok(shares.body.data.every((candidate) => candidate.status !== 'active'));
  const retainedEntry = await request(`/v1/me/expression-entries/${entry.body.data.id}`, { headers: auth(student) });
  assert.equal(retainedEntry.response.status, 200, 'withdrawal stops processing but does not silently delete the student copy');
  const deleted = await request(`/v1/me/expression-entries/${entry.body.data.id}`, { method: 'DELETE', headers: auth(student) });
  assert.equal(deleted.response.status, 204);
  const gone = await request(`/v1/me/expression-entries/${entry.body.data.id}`, { headers: auth(student) });
  assert.equal(gone.response.status, 410);
  assert.ok(store.snapshot().expressionRevocations.some((record) => record.targetType === 'entry' && record.targetId === entry.body.data.id && record.effect === 'delete'));
});
