import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../dist/apps/api/src/main.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState, DEMO_PASSWORD, DEMO_IDS } from '../dist/apps/api/src/domain/seed.js';
import { hashPassword, totpCode } from '../dist/apps/api/src/domain/crypto.js';
import { createCampaign, drainOutbox, publishCampaign } from '../dist/apps/api/src/domain/service.js';

process.env.CAMPMIND_DEMO_MFA = 'true';
process.env.CAMPMIND_MASTER_KEY = 'test-master-key-never-use-in-production';

let server;
let base;
let store;
let opsToken;
const tokenCache = new Map();

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
  if (tokenCache.has(email)) return tokenCache.get(email);
  const { response, body } = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(response.status, 200, JSON.stringify(body));
  tokenCache.set(email, body.data.token);
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
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const pageHtml = await page.text();
  assert.match(pageHtml, /不是诊断/);
  assert.match(pageHtml, /心理教育资源/);
  assert.match(pageHtml, /咨询预约/);
  assert.match(pageHtml, /预约此时段/);
  assert.match(pageHtml, /我的反馈/);
  assert.match(pageHtml, /资料权利申请/);
  const adminPage = await fetch(base + '/admin');
  assert.equal(adminPage.status, 200);
  const adminHtml = await adminPage.text();
  assert.match(adminHtml, /咨询排班与预约/);
  assert.match(adminHtml, /教育内容管理/);
  assert.match(adminHtml, /危机线索工作台/);
  assert.match(adminHtml, /专业报告与心理档案/);
  assert.match(adminHtml, /隐私权利处理队列/);
  assert.match(adminHtml, /处理说明（拒绝时必填）/);
  assert.match(adminHtml, /运行接续与保留任务/);
  assert.match(adminHtml, /隐私保护统计/);
});

test('state-changing requests reject an untrusted browser origin', async () => {
  const { response, body } = await request('/v1/auth/login', { method: 'POST', headers: { origin: 'https://untrusted.example' }, body: JSON.stringify({ email: 'student@campus-mind.demo', password: DEMO_PASSWORD }) });
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'CSRF_ORIGIN_INVALID');
});

test('production entrypoint cannot silently fall back to the JSON adapter', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousBackend = process.env.CAMPMIND_DATA_BACKEND;
  const previousKey = process.env.CAMPMIND_MASTER_KEY;
  const previousMfa = process.env.CAMPMIND_DEMO_MFA;
  process.env.NODE_ENV = 'production';
  process.env.CAMPMIND_DATA_BACKEND = 'postgres';
  process.env.CAMPMIND_MASTER_KEY = 'a-dedicated-test-production-key-that-is-not-local';
  process.env.CAMPMIND_DEMO_MFA = 'false';
  assert.throws(() => createApp(), /injected PostgreSQL-backed store/);
  assert.throws(() => createApp({ store: new JsonStore({ initial: seedDemoState() }) }), /injected PostgreSQL-backed store/);
  process.env.NODE_ENV = previousNodeEnv;
  process.env.CAMPMIND_DATA_BACKEND = previousBackend;
  process.env.CAMPMIND_MASTER_KEY = previousKey;
  process.env.CAMPMIND_DEMO_MFA = previousMfa;
});

test('tenant scope rejects cross-school and cross-tenant identifiers', async () => {
  await store.transaction((state) => {
    const createdAt = new Date().toISOString();
    state.tenants.push({ id: 'tenant-other', name: '第二合成租户', region: 'other', createdAt });
    state.schools.push({ id: 'school-other', tenantId: 'tenant-other', name: '第二合成学校', createdAt });
    state.users.push({ id: 'student-other', tenantId: 'tenant-other', schoolId: 'school-other', email: 'student@other.demo', displayName: '第二合成学生', passwordHash: hashPassword(DEMO_PASSWORD), role: 'student', active: true, mfaEnabled: false, createdAt });
    state.students.push({ id: 'student-other', tenantId: 'tenant-other', schoolId: 'school-other', classId: 'class-other', externalRefHash: 'other-ref', displayNameCiphertext: state.students[0].displayNameCiphertext, age: 15, guardianVerified: false, active: true, createdAt });
  });
  const professional = await login('professional@campus-mind.demo');
  const archive = await request('/v1/students/student-other/archive?purpose=case_review', { headers: auth(professional) });
  assert.equal(archive.response.status, 404);
  const admin = await login('admin@campus-mind.demo');
  const campaign = await request('/v1/campaigns', { method: 'POST', headers: auth(admin), body: JSON.stringify({ schoolId: 'school-demo', name: '跨租户名单', purpose: 'screening', academicYear: '2026-2027', opensAt: new Date(Date.now() - 1_000).toISOString(), closesAt: new Date(Date.now() + 3_600_000).toISOString(), scaleVersionId: 'scale-synthetic-demo-v1', participantStudentIds: ['student-other'] }) });
  assert.equal(campaign.response.status, 403);
});

test('admin MFA is enforced unless demo override is explicitly enabled', async () => {
  const previous = process.env.CAMPMIND_DEMO_MFA;
  process.env.CAMPMIND_DEMO_MFA = 'false';
  const { response, body } = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@campus-mind.demo', password: DEMO_PASSWORD }) });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'MFA_REQUIRED');
  process.env.CAMPMIND_DEMO_MFA = previous;
});

test('enrolled TOTP code completes the named admin MFA challenge', async () => {
  const previous = process.env.CAMPMIND_DEMO_MFA;
  process.env.CAMPMIND_DEMO_MFA = 'false';
  const { response, body } = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@campus-mind.demo', password: DEMO_PASSWORD, mfaCode: totpCode('JBSWY3DPEHPK3PXP') }) });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(Object.hasOwn(body.data.user, 'mfaSecretCiphertext'), false);
  const replay = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@campus-mind.demo', password: DEMO_PASSWORD, mfaCode: totpCode('JBSWY3DPEHPK3PXP') }) });
  assert.equal(replay.response.status, 401);
  assert.equal(replay.body.error.code, 'MFA_REPLAYED');
  process.env.CAMPMIND_DEMO_MFA = previous;
});

test('school issues a one-time short-lived credential for a phone-less student', async () => {
  const admin = await login('admin@campus-mind.demo');
  const issued = await request('/v1/admin/student-credentials', { method: 'POST', headers: auth(admin), body: JSON.stringify({ studentId: 'student-demo', ttlMinutes: 15 }) });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.body));
  assert.match(issued.body.data.code, /^[A-Za-z0-9_-]{40,}$/);
  const stored = store.snapshot().studentAccessCredentials.find((credential) => credential.id === issued.body.data.id);
  assert.ok(stored);
  assert.equal(stored.codeHash.includes(issued.body.data.code), false);
  const redeemed = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: issued.body.data.code }) });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.data.user.id, 'student-demo');
  const replay = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: issued.body.data.code }) });
  assert.equal(replay.response.status, 401);
  assert.equal(replay.body.error.code, 'STUDENT_CREDENTIAL_INVALID');
  const forbiddenIssue = await request('/v1/admin/student-credentials', { method: 'POST', headers: auth(redeemed.body.data.token), body: JSON.stringify({ studentId: 'student-demo' }) });
  assert.equal(forbiddenIssue.response.status, 403);
});

test('school can revoke a student session and all unspent terminal credentials', async () => {
  const admin = await login('admin@campus-mind.demo');
  const issued = await request('/v1/admin/student-credentials', { method: 'POST', headers: auth(admin), body: JSON.stringify({ studentId: 'student-demo', ttlMinutes: 15 }) });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.body));
  const redeemed = await request('/v1/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: issued.body.data.code }) });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.body));

  const revoked = await request('/v1/admin/users/student-demo/sessions/revoke', { method: 'POST', headers: auth(admin), body: '{}' });
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
  assert.ok(revoked.body.data.revoked >= 1);

  const after = await request('/v1/me', { headers: auth(redeemed.body.data.token) });
  assert.equal(after.response.status, 401);
  assert.equal(after.body.error.code, 'UNAUTHORIZED');
  const audit = store.snapshot().auditEvents.find((event) => event.action === 'session.revoked' && event.objectId === 'student-demo');
  assert.ok(audit);
});

test('student assessment lifecycle is durable, revision-safe and idempotent', async () => {
  const token = await login('student@campus-mind.demo');
  const tasks = await request('/v1/me/tasks', { headers: auth(token) });
  assert.equal(tasks.response.status, 200);
  assert.equal(tasks.body.data.length, 1);
  assert.equal(tasks.body.data[0].available, true);
  assert.equal(tasks.body.data[0].availabilityReason, 'available');
  const assignmentId = tasks.body.data[0].id;
  const started = await request(`/v1/me/tasks/${assignmentId}/attempts`, { method: 'POST', headers: auth(token), body: '{}' });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const attemptId = started.body.data.attempt.id;
  const scale = started.body.data.scale;
  const saved = await request(`/v1/attempts/${attemptId}/answers`, { method: 'PUT', headers: auth(token), body: JSON.stringify({ expectedRevision: 0, answers: { q1: 1 } }) });
  assert.equal(saved.response.status, 200);
  const resumed = await request(`/v1/attempts/${attemptId}`, { headers: auth(token) });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.body.data.attempt.currentRevision, saved.body.data.revision);
  assert.equal(resumed.body.data.answers.q1, 1);
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
  assert.ok(store.snapshot().outboxEvents.some((event) => event.type === 'risk.triage' && event.status === 'pending'));
  const drained = await drainOutbox(store);
  assert.ok(drained.processed >= 1);
  assert.ok(store.snapshot().deliveryAttempts.some((attempt) => attempt.channel === 'in_app' && attempt.status === 'sent'));
  const ruleSignal = store.snapshot().riskSignals.find((signal) => signal.submissionId === submitted.body.data.submissionId);
  assert.ok(ruleSignal?.scoreRunId, 'risk signal is linked to the immutable score after scoring');
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
  const leadFollow = await request(`/v1/cases/${caseId}/follow-ups`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ kind: 'support', note: '合成专业负责人支持记录；后续由指派咨询师随访。' }) });
  assert.equal(leadFollow.response.status, 201);
  const follow = await request(`/v1/cases/${caseId}/follow-ups`, { method: 'POST', headers: auth(counselor), body: JSON.stringify({ kind: 'follow_up', note: '合成支持记录；下一次随访待定。' }) });
  assert.equal(follow.response.status, 201);
  const closure = await request(`/v1/cases/${caseId}/closure-requests`, { method: 'POST', headers: auth(counselor), body: JSON.stringify({ reason: '合成随访已记录，申请独立复核。' }) });
  assert.equal(closure.response.status, 200);
  const selfApproval = await request(`/v1/cases/${caseId}/closure-approvals`, { method: 'POST', headers: auth(counselor), body: '{}' });
  assert.equal(selfApproval.response.status, 403);
  assert.equal(selfApproval.body.error.code, 'SEPARATION_OF_DUTIES_REQUIRED');
  const approved = await request(`/v1/cases/${caseId}/closure-approvals`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.state, 'closed');
  const counselorArchive = await request('/v1/students/student-demo/archive?purpose=case_review', { headers: auth(counselor) });
  assert.equal(counselorArchive.response.status, 404, '已结案且未重新授权的咨询师不能读取历史档案');
});

test('report release controls student visibility and service errors do not leak data', async () => {
  const professional = await login('professional@campus-mind.demo');
  const reports = await request('/v1/reports?studentId=student-demo', { headers: auth(professional) });
  assert.equal(reports.response.status, 200);
  assert.equal(reports.body.data.length, 1);
  const missingPurpose = await request('/v1/students/student-demo/archive', { headers: auth(professional) });
  assert.equal(missingPurpose.response.status, 400);
  const invalidPurpose = await request('/v1/students/student-demo/archive?purpose=curiosity', { headers: auth(professional) });
  assert.equal(invalidPurpose.response.status, 400);
  assert.equal(invalidPurpose.body.error.code, 'PURPOSE_INVALID');
  const archive = await request('/v1/students/student-demo/archive?purpose=report_review', { headers: auth(professional) });
  assert.equal(archive.response.status, 200);
  assert.equal(archive.body.data.studentId, 'student-demo');
  const reportId = reports.body.data[0].id;
  const prematureRelease = await request(`/v1/reports/${reportId}/release`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(prematureRelease.response.status, 400);
  assert.equal(prematureRelease.body.error.code, 'REPORT_STATE_INVALID');
  const approvedReport = await request(`/v1/reports/${reportId}/approve`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(approvedReport.response.status, 204);
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

  // A report export is a derived artifact: once the source report is revoked,
  // the previously approved ciphertext must not remain downloadable.
  await store.transaction((state) => {
    const source = state.users.find((candidate) => candidate.id === 'user-professional-demo');
    assert.ok(source);
    if (!state.users.some((candidate) => candidate.id === 'user-professional-export-reviewer')) {
      state.users.push({ ...source, id: 'user-professional-export-reviewer', email: 'export-reviewer@campus-mind.demo', displayName: '演示独立导出审核人' });
    }
  });
  const exportReviewer = await login('export-reviewer@campus-mind.demo');
  const reportExportRequest = await request('/v1/exports', { method: 'POST', headers: auth(professional), body: JSON.stringify({ kind: 'report', studentId: 'student-demo', purpose: 'synthetic_report_export' }) });
  assert.equal(reportExportRequest.response.status, 201, JSON.stringify(reportExportRequest.body));
  const reportExportApprove = await request(`/v1/exports/${reportExportRequest.body.data.id}/approve`, { method: 'POST', headers: auth(exportReviewer), body: '{}' });
  assert.equal(reportExportApprove.response.status, 200, JSON.stringify(reportExportApprove.body));
  assert.equal(reportExportApprove.body.data.ready, true);
  const revoked = await request(`/v1/reports/${reportId}/revoke`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ reason: '合成测试：撤回后导出不得继续使用。' }) });
  assert.equal(revoked.response.status, 204);
  const revokedDownload = await request(`/v1/exports/${reportExportRequest.body.data.id}`, { headers: auth(professional) });
  assert.equal(revokedDownload.response.status, 410);
  assert.equal(revokedDownload.body.error.code, 'EXPORT_REVOKED');
  const revokedJob = store.snapshot().exportJobs.find((job) => job.id === reportExportRequest.body.data.id);
  assert.equal(revokedJob.status, 'revoked');
  assert.equal(revokedJob.payloadCiphertext, undefined);
});


test('imports, governed schemas, aggregate analytics, exports and public content are controlled', async () => {
  const admin = await login('admin@campus-mind.demo');
  const professional = await login('professional@campus-mind.demo');
  const preview = await request('/v1/imports/preview', { method: 'POST', headers: auth(admin), body: JSON.stringify({ schoolId: 'school-demo', filename: 'synthetic-students.csv', rows: [{ externalId: 'synthetic-new-001', displayName: '合成学生甲', age: 14, classId: 'class-demo-1', guardianVerified: false }, { externalId: '', displayName: '缺失编号', age: 14, classId: 'class-demo-1' }] }) });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.body));
  assert.equal(preview.body.data.batch.validRowCount, 1);
  const mismatchedCommit = await request(`/v1/imports/${preview.body.data.batch.id}/commit`, { method: 'POST', headers: auth(admin), body: JSON.stringify({ rows: [{ externalId: 'synthetic-different-001', displayName: '不应绕过预检', age: 14, classId: 'class-demo-1', guardianVerified: false }, { externalId: '', displayName: '缺失编号', age: 14, classId: 'class-demo-1' }] }) });
  assert.equal(mismatchedCommit.response.status, 409);
  assert.equal(mismatchedCommit.body.error.code, 'IMPORT_VERSION_CONFLICT');
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
  const academicYearAnalytics = await request('/v1/analytics/summary?groupBy=academic_year', { headers: auth(professional) });
  assert.equal(academicYearAnalytics.response.status, 200);
  assert.deepEqual(academicYearAnalytics.body.data.rows.map((row) => row.key), ['2026-2027']);
  assert.equal(academicYearAnalytics.body.data.rows[0].suppressed, true);
  const exportRequest = await request('/v1/exports', { method: 'POST', headers: auth(admin), body: JSON.stringify({ kind: 'aggregate' }) });
  assert.equal(exportRequest.response.status, 201);
  const exportApprove = await request(`/v1/exports/${exportRequest.body.data.id}/approve`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(exportApprove.response.status, 200);
  assert.equal(Object.hasOwn(exportApprove.body.data, 'payloadCiphertext'), false);
  assert.equal(exportApprove.body.data.ready, true);
  assert.equal(exportApprove.body.data.purpose, 'approved_aggregate_reporting');
  const exportDownload = await request(`/v1/exports/${exportRequest.body.data.id}`, { headers: auth(admin) });
  assert.equal(exportDownload.response.status, 200);
  assert.equal(exportDownload.body.data.suppressionThreshold, 10);
  assert.equal(exportDownload.body.data.watermark.jobId, exportRequest.body.data.id);
  assert.equal(exportDownload.body.data.watermark.approvedBy, 'user-professional-demo');
  await store.transaction((state) => {
    const job = state.exportJobs.find((candidate) => candidate.id === exportRequest.body.data.id);
    job.expiresAt = '2020-01-01T00:00:00.000Z';
  });
  const expiredDownload = await request(`/v1/exports/${exportRequest.body.data.id}`, { headers: auth(admin) });
  assert.equal(expiredDownload.response.status, 410);
  assert.equal(expiredDownload.body.error.code, 'EXPORT_EXPIRED');
  const expiredJob = store.snapshot().exportJobs.find((job) => job.id === exportRequest.body.data.id);
  assert.equal(expiredJob.status, 'expired');
  assert.equal(expiredJob.payloadCiphertext, undefined);

  const selfApproval = await request('/v1/exports', { method: 'POST', headers: auth(professional), body: JSON.stringify({ kind: 'aggregate', purpose: 'synthetic_self_approval_check' }) });
  assert.equal(selfApproval.response.status, 201);
  const selfApproved = await request(`/v1/exports/${selfApproval.body.data.id}/approve`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(selfApproved.response.status, 403);
  assert.equal(selfApproved.body.error.code, 'SEPARATION_OF_DUTIES_REQUIRED');
  const expiredApprovalRequest = await request('/v1/exports', { method: 'POST', headers: auth(admin), body: JSON.stringify({ kind: 'aggregate', purpose: 'synthetic_expired_approval' }) });
  assert.equal(expiredApprovalRequest.response.status, 201);
  await store.transaction((state) => {
    const job = state.exportJobs.find((candidate) => candidate.id === expiredApprovalRequest.body.data.id);
    job.expiresAt = '2020-01-01T00:00:00.000Z';
  });
  const expiredApproval = await request(`/v1/exports/${expiredApprovalRequest.body.data.id}/approve`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(expiredApproval.response.status, 410);
  assert.equal(expiredApproval.body.error.code, 'EXPORT_EXPIRED');
  assert.equal(store.snapshot().exportJobs.find((job) => job.id === expiredApprovalRequest.body.data.id).status, 'expired');
  const slot = await request('/v1/availability-slots', { method: 'POST', headers: auth(professional), body: JSON.stringify({ counselorId: 'user-counselor-demo', startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString(), room: '合成咨询室' }) });
  assert.equal(slot.response.status, 201);
  const roomConflict = await request('/v1/availability-slots', { method: 'POST', headers: auth(professional), body: JSON.stringify({ counselorId: 'user-professional-demo', startsAt: new Date(Date.now() + 4_000_000).toISOString(), endsAt: new Date(Date.now() + 6_000_000).toISOString(), room: '合成咨询室' }) });
  assert.equal(roomConflict.response.status, 409);
  assert.equal(roomConflict.body.error.code, 'SLOT_CONFLICT');
  const appointment = await request('/v1/appointments', { method: 'POST', headers: auth(student), body: JSON.stringify({ slotId: slot.body.data.id, note: '合成预约说明' }) });
  assert.equal(appointment.response.status, 201);
  const confirmed = await request(`/v1/appointments/${appointment.body.data.id}/state`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ state: 'confirmed' }) });
  assert.equal(confirmed.response.status, 200);
  const content = await request('/v1/content', { method: 'POST', headers: auth(professional), body: JSON.stringify({ title: '如何找到可信任的支持', kind: 'article', body: '合成教育内容：可以向可信任的成人或专业老师表达需要。', ageMin: 12, ageMax: 18, copyrightSource: 'synthetic-only' }) });
  assert.equal(content.response.status, 201);
  const contentDrafts = await request('/v1/content', { headers: auth(professional) });
  assert.equal(contentDrafts.response.status, 200, JSON.stringify(contentDrafts.body));
  const draft = contentDrafts.body.data.find((item) => item.id === content.body.data.id);
  assert.equal(draft.body, '合成教育内容：可以向可信任的成人或专业老师表达需要。');
  assert.equal(Object.hasOwn(draft, 'bodyCiphertext'), false);
  const published = await request(`/v1/content/${content.body.data.id}/publish`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(published.response.status, 200);
  const publicContent = await request('/v1/content/public?age=15');
  assert.equal(publicContent.response.status, 200);
  assert.ok(publicContent.body.data.some((item) => item.id === content.body.data.id));
  const invalidContentAge = await request('/v1/content/public?age=not-an-age');
  assert.equal(invalidContentAge.response.status, 400);
  assert.equal(invalidContentAge.body.error.code, 'CONTENT_AGE_INVALID');
  const retired = await request(`/v1/content/${content.body.data.id}/retire`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(retired.response.status, 200);
  const afterRetire = await request('/v1/content/public?age=15');
  assert.equal(afterRetire.body.data.some((item) => item.id === content.body.data.id), false);
  const media = await request('/v1/media-assets', { method: 'POST', headers: auth(professional), body: JSON.stringify({ filename: 'synthetic.png', mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }) });
  assert.equal(media.response.status, 201, JSON.stringify(media.body));
  const duplicateMedia = await request('/v1/media-assets', { method: 'POST', headers: auth(professional), body: JSON.stringify({ filename: 'synthetic-copy.png', mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }) });
  assert.equal(duplicateMedia.response.status, 409);
  assert.equal(duplicateMedia.body.error.code, 'MEDIA_DUPLICATE');
  const mediaContent = await request('/v1/content', { method: 'POST', headers: auth(professional), body: JSON.stringify({ title: '合成图示', kind: 'media', body: '合成教育图示说明。', ageMin: 12, ageMax: 18, copyrightSource: 'synthetic-only', mediaAssetId: media.body.data.id, altText: '合成的安全支持图示' }) });
  assert.equal(mediaContent.response.status, 201, JSON.stringify(mediaContent.body));
  const mediaPublished = await request(`/v1/content/${mediaContent.body.data.id}/publish`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(mediaPublished.response.status, 200);
  const mediaPublic = await request('/v1/content/public?age=15');
  const publicMediaItem = mediaPublic.body.data.find((item) => item.id === mediaContent.body.data.id);
  assert.equal(publicMediaItem.media.id, media.body.data.id);
  assert.equal(publicMediaItem.media.url, `/v1/content/public/${media.body.data.id}/media`);
  const mediaBytes = await fetch(`${base}/v1/content/public/${media.body.data.id}/media`);
  assert.equal(mediaBytes.status, 200);
  assert.equal(mediaBytes.headers.get('content-type'), 'image/png');
  assert.equal(mediaBytes.headers.get('cache-control'), 'no-store');
  assert.equal((await mediaBytes.arrayBuffer()).byteLength > 8, true);
  const retiredMedia = await request(`/v1/content/${mediaContent.body.data.id}/retire`, { method: 'POST', headers: auth(professional), body: '{}' });
  assert.equal(retiredMedia.response.status, 200);
  const hiddenMedia = await fetch(`${base}/v1/content/public/${media.body.data.id}/media`);
  assert.equal(hiddenMedia.status, 404);
});


test('appointment slots are scoped and booking retries are idempotent', async () => {
  const professional = await login('professional@campus-mind.demo');
  const student = await login('student@campus-mind.demo');
  const startsAt = new Date(Date.now() + 10 * 3_600_000).toISOString();
  const endsAt = new Date(Date.now() + 11 * 3_600_000).toISOString();
  const created = await request('/v1/availability-slots', { method: 'POST', headers: auth(professional), body: JSON.stringify({ counselorId: 'user-counselor-demo', startsAt, endsAt, room: '合成预约室-幂等' }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const slotId = created.body.data.id;
  const visible = await request('/v1/availability-slots', { headers: auth(student) });
  assert.equal(visible.response.status, 200, JSON.stringify(visible.body));
  const listedSlot = visible.body.data.find((slot) => slot.id === slotId);
  assert.equal(listedSlot.counselorName, '演示心理咨询师');
  assert.equal(listedSlot.status, 'available');
  const key = 'synthetic-appointment-retry-001';
  const first = await request('/v1/appointments', { method: 'POST', headers: auth(student), body: JSON.stringify({ slotId, note: '合成预约说明', idempotencyKey: key }) });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(Object.hasOwn(first.body.data, 'noteCiphertext'), false);
  assert.equal(Object.hasOwn(first.body.data, 'idempotencyHash'), false);
  const retry = await request('/v1/appointments', { method: 'POST', headers: auth(student), body: JSON.stringify({ slotId, note: '合成预约说明', idempotencyKey: key }) });
  assert.equal(retry.response.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.data.id, first.body.data.id);
  const keyConflict = await request('/v1/appointments', { method: 'POST', headers: auth(student), body: JSON.stringify({ slotId, note: '不同的合成说明', idempotencyKey: key }) });
  assert.equal(keyConflict.response.status, 409);
  assert.equal(keyConflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const studentAppointments = await request('/v1/appointments', { headers: auth(student) });
  assert.equal(studentAppointments.response.status, 200);
  const ownAppointment = studentAppointments.body.data.find((appointment) => appointment.id === first.body.data.id);
  assert.ok(ownAppointment);
  assert.equal(Object.hasOwn(ownAppointment, 'note'), false);
  const managerAppointments = await request('/v1/appointments', { headers: auth(professional) });
  assert.equal(managerAppointments.response.status, 200);
  assert.equal(managerAppointments.body.data.find((appointment) => appointment.id === first.body.data.id).studentId, 'student-demo');
  const invalidStatus = await request(`/v1/availability-slots/${slotId}/state`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ status: 'bogus' }) });
  assert.equal(invalidStatus.response.status, 400);
  assert.equal(invalidStatus.body.error.code, 'SLOT_STATUS_INVALID');
  const heldBlock = await request(`/v1/availability-slots/${slotId}/state`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ status: 'blocked' }) });
  assert.equal(heldBlock.response.status, 409);
  assert.equal(heldBlock.body.error.code, 'SLOT_HELD');
  const cancelled = await request(`/v1/appointments/${first.body.data.id}/state`, { method: 'POST', headers: auth(student), body: JSON.stringify({ state: 'cancelled' }) });
  assert.equal(cancelled.response.status, 200);
  assert.equal(Object.hasOwn(cancelled.body.data, 'noteCiphertext'), false);
  assert.equal(Object.hasOwn(cancelled.body.data, 'idempotencyKey'), false);
  const blocked = await request(`/v1/availability-slots/${slotId}/state`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ status: 'blocked' }) });
  assert.equal(blocked.response.status, 200);
  const hidden = await request('/v1/availability-slots', { headers: auth(student) });
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.body.data.some((slot) => slot.id === slotId), false);
  const reopened = await request(`/v1/availability-slots/${slotId}/state`, { method: 'POST', headers: auth(professional), body: JSON.stringify({ status: 'available' }) });
  assert.equal(reopened.response.status, 200);
});

test('teacher progress is limited to operational counts', async () => {
  const teacher = await login('teacher@campus-mind.demo');
  const progress = await request('/v1/campaigns/campaign-demo/progress', { headers: auth(teacher) });
  assert.equal(progress.response.status, 200);
  assert.equal(progress.body.data.completed, 1);
  assert.match(progress.body.data.note, /不包含分数/);
  assert.equal(Object.hasOwn(progress.body.data, 'studentIds'), false);
  const students = await request('/v1/admin/students', { headers: auth(teacher) });
  assert.equal(students.response.status, 403, '班主任不可读取完整学生目录');
  const slots = await request('/v1/availability-slots', { headers: auth(teacher) });
  assert.equal(slots.response.status, 403, '班主任不可管理或读取预约排班');
  const content = await request('/v1/content', { headers: auth(teacher) });
  assert.equal(content.response.status, 403, '班主任不可读取教育内容草稿');
});

test('rights requests are auditable and privacy staff can complete non-destructive access requests', async () => {
  const student = await login('student@campus-mind.demo');
  const privacy = await login('privacy@campus-mind.demo');
  const created = await request('/v1/rights-requests', { method: 'POST', headers: auth(student), body: JSON.stringify({ studentId: 'student-demo', kind: 'access', reason: '合成演示查阅申请' }) });
  assert.equal(created.response.status, 201);
  const ownRequests = await request('/v1/me/rights-requests', { headers: auth(student) });
  assert.equal(ownRequests.response.status, 200, JSON.stringify(ownRequests.body));
  assert.equal(ownRequests.body.data.some((item) => item.id === created.body.data.id), true);
  assert.equal(ownRequests.body.data.find((item) => item.id === created.body.data.id).resultReady, false);
  const privacyOwn = await request('/v1/me/rights-requests', { headers: auth(privacy) });
  assert.equal(privacyOwn.response.status, 403);
  const listed = await request('/v1/admin/rights-requests', { headers: auth(privacy) });
  assert.equal(listed.response.status, 200);
  const completed = await request(`/v1/admin/rights-requests/${created.body.data.id}/complete`, { method: 'POST', headers: auth(privacy), body: JSON.stringify({ decision: 'complete' }) });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.data.status, 'completed');
  assert.equal(Object.hasOwn(completed.body.data, 'resultCiphertext'), false);
  assert.equal(completed.body.data.resultReady, true);
  const result = await request(`/v1/rights-requests/${created.body.data.id}/result`, { headers: auth(student) });
  assert.equal(result.response.status, 200);
  assert.match(result.body.data.note, /不包含原始答卷/);
  const after = await request('/v1/me/rights-requests', { headers: auth(student) });
  assert.equal(after.response.status, 200);
  assert.equal(after.body.data.find((item) => item.id === created.body.data.id).resultReady, true);
  const rejectedRequest = await request('/v1/rights-requests', { method: 'POST', headers: auth(student), body: JSON.stringify({ studentId: 'student-demo', kind: 'correct', reason: '合成演示更正申请' }) });
  assert.equal(rejectedRequest.response.status, 201);
  const missingDecisionReason = await request(`/v1/admin/rights-requests/${rejectedRequest.body.data.id}/complete`, { method: 'POST', headers: auth(privacy), body: JSON.stringify({ decision: 'reject' }) });
  assert.equal(missingDecisionReason.response.status, 400);
  assert.equal(missingDecisionReason.body.error.code, 'RIGHTS_DECISION_REASON_REQUIRED');
  const rejected = await request(`/v1/admin/rights-requests/${rejectedRequest.body.data.id}/complete`, { method: 'POST', headers: auth(privacy), body: JSON.stringify({ decision: 'reject', decisionReason: '合成演示：无法核验申请范围' }) });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.data.resultReady, true);
  const rejectionResult = await request(`/v1/rights-requests/${rejectedRequest.body.data.id}/result`, { headers: auth(student) });
  assert.equal(rejectionResult.response.status, 200);
  assert.match(rejectionResult.body.data.reason, /无法核验/);
  const audit = await request('/v1/admin/audit?limit=20', { headers: auth(privacy) });
  assert.equal(audit.response.status, 200, JSON.stringify(audit.body));
  assert.ok(audit.body.data.some((event) => event.action === 'rights.completed'));
  assert.ok(store.snapshot().auditEvents.some((event) => event.action === 'audit.listed'));
});

test('guardian consent requires a verified guardian link and rejects role spoofing', async () => {
  const admin = await login('admin@campus-mind.demo');
  const guardian = await login('guardian@campus-mind.demo');
  const verified = await request('/v1/guardian-links/guardian-link-demo/verify', { method: 'POST', headers: auth(admin), body: '{}' });
  assert.equal(verified.response.status, 200);
  const consent = await request('/v1/me/consents', { method: 'POST', headers: auth(guardian), body: JSON.stringify({ studentId: 'student-demo', actorType: 'guardian', noticeVersion: 'notice-support-v1', purpose: 'support' }) });
  assert.equal(consent.response.status, 201);
  const withdrawn = await request(`/v1/me/consents/${consent.body.data.id}/withdraw`, { method: 'POST', headers: auth(guardian), body: '{}' });
  assert.equal(withdrawn.response.status, 204);
  const student = await login('student@campus-mind.demo');
  const spoof = await request('/v1/me/consents', { method: 'POST', headers: auth(student), body: JSON.stringify({ studentId: 'student-demo', actorType: 'guardian', noticeVersion: 'notice-spoof-v1', purpose: 'research' }) });
  assert.equal(spoof.response.status, 403);
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
  opsToken = await login('ops@campus-mind.demo');
  const drained = await request('/v1/admin/worker/drain', { method: 'POST', headers: auth(opsToken), body: '{}' });
  assert.equal(drained.response.status, 200);
  const regional = await request('/v1/admin/regional-analytics', { headers: auth(opsToken) });
  assert.equal(regional.response.status, 200);
  assert.equal(regional.body.data.rows[0].suppressed, true);
  assert.ok(store.snapshot().auditEvents.some((event) => event.action === 'analytics.viewed'));
  assert.ok(store.snapshot().auditEvents.some((event) => event.action === 'analytics.regional_viewed'));
});

test('workflow inputs reject invalid enums, dates and governed field shapes', async () => {
  const admin = await login('admin@campus-mind.demo');
  const professional = await login('professional@campus-mind.demo');
  const invalidCampaign = await request('/v1/campaigns', { method: 'POST', headers: auth(admin), body: JSON.stringify({ schoolId: 'school-demo', name: 'invalid', purpose: 'diagnosis', academicYear: '2026-2027', opensAt: 'not-a-date', closesAt: 'also-not-a-date', scaleVersionId: 'scale-synthetic-demo-v1', participantStudentIds: [] }) });
  assert.equal(invalidCampaign.response.status, 400);
  assert.equal(invalidCampaign.body.error.code, 'CAMPAIGN_INVALID');
  const invalidContent = await request('/v1/content', { method: 'POST', headers: auth(professional), body: JSON.stringify({ title: 'invalid', kind: 'diagnosis', body: '内容', ageMin: 12, ageMax: 18, copyrightSource: 'synthetic-only' }) });
  assert.equal(invalidContent.response.status, 400);
  assert.equal(invalidContent.body.error.code, 'CONTENT_INVALID');
  const invalidSchema = await request('/v1/profile-schemas', { method: 'POST', headers: auth(professional), body: JSON.stringify({ version: 'invalid-v1', fields: [{ id: 'field', label: '字段', purpose: '演示', required: 'yes', sensitive: true }] }) });
  assert.equal(invalidSchema.response.status, 400);
  assert.equal(invalidSchema.body.error.code, 'PROFILE_SCHEMA_INVALID');
  const duplicateSchema = await request('/v1/profile-schemas', { method: 'POST', headers: auth(professional), body: JSON.stringify({ version: 'demo-v1', fields: [{ id: 'sleep', label: '睡眠情况', purpose: '合成演示字段', required: false, sensitive: true }] }) });
  assert.equal(duplicateSchema.response.status, 409);
  assert.equal(duplicateSchema.body.error.code, 'PROFILE_SCHEMA_VERSION_EXISTS');
  const invalidSignal = await request('/v1/risk-signals', { method: 'POST', headers: auth(professional), body: JSON.stringify({ studentId: 'student-demo', level: 'urgent', reason: '' }) });
  assert.equal(invalidSignal.response.status, 400);
  assert.equal(invalidSignal.body.error.code, 'FIELD_REQUIRED');
  const spoofedSource = await request('/v1/risk-signals', { method: 'POST', headers: auth(professional), body: JSON.stringify({ studentId: 'student-demo', level: 'attention', source: 'score_rule', reason: '合成来源伪造' }) });
  assert.equal(spoofedSource.response.status, 400);
  assert.equal(spoofedSource.body.error.code, 'RISK_SIGNAL_SOURCE_INVALID');
  const invalidAppointment = await request('/v1/appointments/does-not-matter/state', { method: 'POST', headers: auth(professional), body: JSON.stringify({ state: 'bogus' }) });
  assert.equal(invalidAppointment.response.status, 400);
  assert.equal(invalidAppointment.body.error.code, 'APPOINTMENT_STATE_INVALID');
  const invalidReview = await request('/v1/cases/does-not-matter/reviews', { method: 'POST', headers: auth(professional), body: JSON.stringify({ decision: 'bogus', note: '说明' }) });
  assert.equal(invalidReview.response.status, 400);
  assert.equal(invalidReview.body.error.code, 'CASE_REVIEW_INVALID');
  const invalidExport = await request('/v1/exports', { method: 'POST', headers: auth(admin), body: JSON.stringify({ kind: 'raw_answers' }) });
  assert.equal(invalidExport.response.status, 400);
  assert.equal(invalidExport.body.error.code, 'EXPORT_KIND_INVALID');
  const invalidExportPurpose = await request('/v1/exports', { method: 'POST', headers: auth(admin), body: JSON.stringify({ kind: 'aggregate', purpose: { raw: 'not-a-string' } }) });
  assert.equal(invalidExportPurpose.response.status, 400);
  assert.equal(invalidExportPurpose.body.error.code, 'EXPORT_PURPOSE_INVALID');
  const operations = await request('/v1/admin/operations/status', { headers: auth(opsToken) });
  assert.equal(operations.response.status, 200);
  assert.equal(Object.hasOwn(operations.body.data, 'riskSignals'), false);
  const retention = await request('/v1/admin/retention/run', { method: 'POST', headers: auth(opsToken), body: JSON.stringify({ asOf: '2026-09-11T00:00:00.000Z' }) });
  assert.equal(retention.response.status, 200);
});
