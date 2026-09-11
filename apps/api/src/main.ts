import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXlsxBase64 } from './domain/spreadsheet.js';
import { adminOverview, addFollowUp, acknowledgeCase, approveClosure, approveContent, approveExport, approveProfileSchema, approveReport, approveScale, assignCase, beginAttempt, campaignProgress, commitImport, createAvailabilitySlot, createCampaign, createConsent, createContent, createProfileSchema, createRiskSignal, createScale, createSelfScreening, currentUser, regionalAnalytics, submitProfileResponse, drainOutbox, downloadExport, getAnalytics, listCases, listCampaigns, listMyTasks, listPublicContent, listReports, listScaleCatalog, listStudents, listRightsRequests, parseCsv, previewImport, publishCampaign, requestAppointment, requestClosure, requestExport, reviewCase, saveAnswers, submitAttempt, updateAppointment, withdrawConsent, completeRightsRequest, createRightsRequest } from './domain/service.js';
import { authenticate, login as loginUser, logout, requirePermission } from './domain/auth.js';
import { DomainError, unauthorized } from './domain/errors.js';
import { JsonStore } from './domain/store.js';
import { seedDemoState } from './domain/seed.js';
import type { AuthenticatedUser, DatabaseState } from './domain/types.js';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_FILE = process.env.CAMPMIND_DATA_FILE ?? resolve(process.cwd(), 'private-data/demo-store.json');
const MAX_BODY_BYTES = 1_500_000;

function loadStore(): JsonStore {
  if (!existsSync(DATA_FILE) && process.env.NODE_ENV !== 'production') {
    mkdirSync(resolve(DATA_FILE, '..'), { recursive: true, mode: 0o700 });
    return new JsonStore({ filePath: DATA_FILE, initial: seedDemoState() });
  }
  return new JsonStore({ filePath: DATA_FILE });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function headers(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof DomainError) {
    json(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }
  console.error(error);
  json(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请联系学校支持人员。' } });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new DomainError('REQUEST_TOO_LARGE', '请求内容过大', 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch { throw new DomainError('INVALID_JSON', '请求 JSON 无效'); }
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('FIELD_REQUIRED', `缺少字段 ${key}`);
  return value.trim();
}

function arrayField(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new DomainError('FIELD_REQUIRED', `字段 ${key} 必须是数组`);
  return value;
}

function publicScale(scale: DatabaseState['scales'][number]): Record<string, unknown> {
  return { id: scale.id, code: scale.code, title: scale.title, version: scale.version, provenance: scale.provenance, minAge: scale.minAge, maxAge: scale.maxAge, noticeVersion: scale.noticeVersion, items: scale.items.map((item) => ({ id: item.id, prompt: item.prompt, min: item.min, max: item.max, factor: item.factor })) };
}

export interface AppOptions { store?: JsonStore; }

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? loadStore();
  const server = createServer(async (req, res) => {
    headers(res);
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (method === 'GET' && path === '/health') { json(res, 200, { status: 'ok', service: 'campus-mind-api', version: '0.1.0', demo: process.env.NODE_ENV !== 'production' }); return; }
      if (method === 'GET' && (path === '/' || path === '/admin' || path === '/student')) { servePage(res, path); return; }
      if (path.startsWith('/v1/')) await routeApi(req, res, method, path, url, store);
      else json(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
    } catch (error) { sendError(res, error); }
  });
  return server;
}

function servePage(res: ServerResponse, path: string): void {
  const file = path === '/admin' ? 'apps/admin-web/index.html' : path === '/student' ? 'apps/student-web/index.html' : 'README.md';
  const fullPath = resolve(process.cwd(), file);
  if (path === '/') { json(res, 200, { service: 'campus-mind', links: { admin: '/admin', student: '/student', health: '/health' }, notice: '开发演示，不连接真实学生资料。' }); return; }
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(readFileSync(fullPath));
}

async function getAuth(req: IncomingMessage, store: JsonStore): Promise<AuthenticatedUser> {
  return authenticate(store, req.headers.authorization);
}

async function routeApi(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL, store: JsonStore): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const input = method !== 'GET' && method !== 'DELETE' ? await body(req) : {};
  if (method === 'GET' && path === '/v1/content/public') { json(res, 200, { data: await listPublicContent(store, url.searchParams.has('age') ? Number(url.searchParams.get('age')) : undefined) }); return; }
  if (method === 'POST' && path === '/v1/auth/login') {
    const result = await loginUser(store, stringField(input, 'email'), stringField(input, 'password'));
    json(res, 200, { data: result }); return;
  }
  if (method === 'POST' && path === '/v1/auth/logout') {
    const auth = await getAuth(req, store); await logout(store, auth.session); json(res, 204, {}); return;
  }
  const auth = await getAuth(req, store);
  if (method === 'GET' && path === '/v1/me') { json(res, 200, { data: await currentUser(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/students') { json(res, 200, { data: await listStudents(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/campaigns') { json(res, 200, { data: await listCampaigns(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/scales') { json(res, 200, { data: await listScaleCatalog(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/me/tasks') { json(res, 200, { data: await listMyTasks(store, auth) }); return; }
  if (method === 'POST' && path === '/v1/me/consents') {
    const result = await createConsent(store, auth, { studentId: stringField(input, 'studentId'), actorType: (input.actorType as 'student' | 'guardian' | 'school_legal_basis') ?? 'student', noticeVersion: stringField(input, 'noticeVersion'), purpose: (input.purpose as 'assessment' | 'support' | 'research') ?? 'assessment' });
    json(res, 201, { data: result }); return;
  }
  if (method === 'POST' && segments[1] === 'me' && segments[2] === 'consents' && segments[4] === 'withdraw') { await withdrawConsent(store, auth, segments[3]!); json(res, 204, {}); return; }
  if (method === 'POST' && path === '/v1/imports/preview-csv') {
    const csv = stringField(input, 'csv');
    const rows = parseCsv(csv).map((row) => ({ ...row, age: Number(row.age), guardianVerified: row.guardianVerified === 'true' }));
    const result = await previewImport(store, auth, { schoolId: stringField(input, 'schoolId'), filename: typeof input.filename === 'string' ? input.filename : 'upload.csv', rows }); json(res, 201, { data: result }); return;
  }
  if (method === 'POST' && path === '/v1/imports/preview-xlsx') {
    const encoded = stringField(input, 'xlsxBase64');
    const rows = parseXlsxBase64(encoded).map((row) => ({ ...row, age: Number(row.age), guardianVerified: row.guardianVerified === 'true' }));
    const result = await previewImport(store, auth, { schoolId: stringField(input, 'schoolId'), filename: typeof input.filename === 'string' ? input.filename : 'upload.xlsx', rows }); json(res, 201, { data: result }); return;
  }
  if (method === 'POST' && path === '/v1/imports/preview') {
    const rows = arrayField(input, 'rows').filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
    const result = await previewImport(store, auth, { schoolId: stringField(input, 'schoolId'), filename: stringField(input, 'filename'), rows }); json(res, 201, { data: result }); return;
  }
  if (method === 'POST' && segments[1] === 'imports' && segments[3] === 'commit') {
    const rows = arrayField(input, 'rows').filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
    const result = await commitImport(store, auth, segments[2]!, rows); json(res, 200, { data: result }); return;
  }
  if (method === 'POST' && path === '/v1/scales') {
    const scale = await createScale(store, auth, { code: stringField(input, 'code'), title: stringField(input, 'title'), version: stringField(input, 'version'), provenance: (input.provenance as 'synthetic_only' | 'licensed') ?? 'synthetic_only', minAge: Number(input.minAge), maxAge: Number(input.maxAge), scoringVersion: stringField(input, 'scoringVersion'), noticeVersion: stringField(input, 'noticeVersion'), items: arrayField(input, 'items') as never, warningRule: input.warningRule as never }); json(res, 201, { data: publicScale(scale) }); return;
  }
  if (method === 'POST' && segments[1] === 'scales' && segments[3] === 'approve') { const scale = await approveScale(store, auth, segments[2]!); json(res, 200, { data: publicScale(scale) }); return; }
  if (method === 'POST' && path === '/v1/campaigns') {
    const ids = arrayField(input, 'participantStudentIds').map((value) => String(value));
    const campaign = await createCampaign(store, auth, { schoolId: stringField(input, 'schoolId'), name: stringField(input, 'name'), purpose: (input.purpose as 'screening' | 'survey') ?? 'screening', academicYear: stringField(input, 'academicYear'), opensAt: stringField(input, 'opensAt'), closesAt: stringField(input, 'closesAt'), scaleVersionId: stringField(input, 'scaleVersionId'), participantStudentIds: ids }); json(res, 201, { data: campaign }); return;
  }
  if (method === 'POST' && segments[1] === 'campaigns' && segments[3] === 'publish') { const campaign = await publishCampaign(store, auth, segments[2]!); json(res, 200, { data: campaign }); return; }
  if (method === 'GET' && segments[1] === 'campaigns' && segments[3] === 'progress') { const progress = await campaignProgress(store, auth, segments[2]!); json(res, 200, { data: progress }); return; }
  if (method === 'GET' && path === '/v1/me/scales') {
    requirePermission(auth.user, 'self:assessment'); const scales = await store.read((state) => state.scales.filter((scale) => scale.tenantId === auth.user.tenantId).map(publicScale)); json(res, 200, { data: scales }); return;
  }
  if (method === 'POST' && segments[1] === 'me' && segments[2] === 'tasks' && segments[4] === 'attempts') { const result = await beginAttempt(store, auth, segments[3]!); json(res, 201, { data: { attempt: result.attempt, scale: publicScale(result.scale) } }); return; }
  if (method === 'POST' && path === '/v1/me/profile-responses') { const result = await submitProfileResponse(store, auth, { schemaId: stringField(input, 'schemaId'), values: (input.values as Record<string, unknown>) ?? {} }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && path === '/v1/self-screenings') { const result = await createSelfScreening(store, auth, stringField(input, 'scaleId'), typeof input.academicYear === 'string' ? input.academicYear : undefined); json(res, 201, { data: result }); return; }
  if (method === 'PUT' && segments[1] === 'attempts' && segments[3] === 'answers') { const result = await saveAnswers(store, auth, segments[2]!, { expectedRevision: Number(input.expectedRevision), answers: (input.answers as Record<string, unknown>) ?? {} }); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'attempts' && segments[3] === 'submit') { const result = await submitAttempt(store, auth, segments[2]!, stringField(input, 'idempotencyKey')); json(res, 202, { data: result }); return; }
  if (method === 'GET' && path === '/v1/reports') { const result = await listReports(store, auth, url.searchParams.get('studentId') ?? undefined); json(res, 200, { data: result }); return; }
  if (method === 'GET' && segments[1] === 'reports' && segments.length === 3) {
    const reports = await listReports(store, auth);
    const report = reports.find((candidate) => candidate.id === segments[2]);
    if (!report) throw new DomainError('NOT_FOUND', '资源不存在', 404);
    json(res, 200, { data: report }); return;
  }
  if (method === 'POST' && segments[1] === 'reports' && segments[3] === 'approve') { await approveReport(store, auth, segments[2]!, false); json(res, 204, {}); return; }
  if (method === 'POST' && segments[1] === 'reports' && segments[3] === 'release') { await approveReport(store, auth, segments[2]!, true); json(res, 204, {}); return; }
  if (method === 'POST' && path === '/v1/risk-signals') { const riskCase = await createRiskSignal(store, auth, { studentId: stringField(input, 'studentId'), level: (input.level as 'attention' | 'urgent') ?? 'attention', reason: stringField(input, 'reason'), source: input.source as never }); json(res, 201, { data: riskCase }); return; }
  if (method === 'GET' && path === '/v1/cases') { json(res, 200, { data: await listCases(store, auth) }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'reviews') { const result = await reviewCase(store, auth, segments[2]!, { decision: input.decision === 'dismiss' ? 'dismiss' : 'confirm', note: stringField(input, 'note') }); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'assign') { const result = await assignCase(store, auth, segments[2]!, stringField(input, 'assigneeId')); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'acknowledgements') { const result = await acknowledgeCase(store, auth, segments[2]!); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'follow-ups') { const result = await addFollowUp(store, auth, segments[2]!, { kind: (input.kind as 'support' | 'referral' | 'follow_up') ?? 'support', note: stringField(input, 'note'), dueAt: typeof input.dueAt === 'string' ? input.dueAt : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'closure-requests') { const result = await requestClosure(store, auth, segments[2]!, stringField(input, 'reason')); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'closure-approvals') { const result = await approveClosure(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/rights-requests') { const result = await createRightsRequest(store, auth, { studentId: stringField(input, 'studentId'), kind: (input.kind as 'access' | 'correct' | 'delete' | 'withdraw') ?? 'access', reason: typeof input.reason === 'string' ? input.reason : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'GET' && path === '/v1/admin/rights-requests') { json(res, 200, { data: await listRightsRequests(store, auth) }); return; }
  if (method === 'POST' && segments[1] === 'admin' && segments[2] === 'rights-requests' && segments[4] === 'complete') { const result = await completeRightsRequest(store, auth, segments[3]!, input.decision === 'reject' ? 'reject' : 'complete'); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/exports') { const result = await requestExport(store, auth, { kind: input.kind === 'report' ? 'report' : 'aggregate', studentId: typeof input.studentId === 'string' ? input.studentId : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'exports' && segments[3] === 'approve') { const result = await approveExport(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'GET' && segments[1] === 'exports' && segments.length === 3) { const result = await downloadExport(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'GET' && path === '/v1/analytics/summary') { json(res, 200, { data: await getAnalytics(store, auth, url.searchParams.get('groupBy') ?? 'school') }); return; }
  if (method === 'POST' && path === '/v1/profile-schemas') { const result = await createProfileSchema(store, auth, { version: stringField(input, 'version'), fields: arrayField(input, 'fields') as never }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'profile-schemas' && segments[3] === 'approve') { const result = await approveProfileSchema(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/availability-slots') { const result = await createAvailabilitySlot(store, auth, { counselorId: stringField(input, 'counselorId'), startsAt: stringField(input, 'startsAt'), endsAt: stringField(input, 'endsAt'), room: typeof input.room === 'string' ? input.room : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && path === '/v1/appointments') { const result = await requestAppointment(store, auth, { slotId: stringField(input, 'slotId'), note: typeof input.note === 'string' ? input.note : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'appointments' && segments[3] === 'state') { const result = await updateAppointment(store, auth, segments[2]!, (input.state as 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show') ?? 'cancelled'); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/content') { const result = await createContent(store, auth, { title: stringField(input, 'title'), kind: (input.kind as 'article' | 'announcement' | 'media') ?? 'article', body: stringField(input, 'body'), ageMin: Number(input.ageMin), ageMax: Number(input.ageMax), copyrightSource: stringField(input, 'copyrightSource') }); json(res, 201, { data: { ...result, bodyCiphertext: undefined } }); return; }
  if (method === 'POST' && segments[1] === 'content' && segments[3] === 'publish') { const result = await approveContent(store, auth, segments[2]!); json(res, 200, { data: { id: result.id, state: result.state, publishedAt: result.publishedAt } }); return; }
  if (method === 'GET' && path === '/v1/admin/regional-analytics') { json(res, 200, { data: await regionalAnalytics(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/overview') { json(res, 200, { data: await adminOverview(store, auth) }); return; }
  if (method === 'POST' && path === '/v1/admin/worker/drain') { requirePermission(auth.user, 'system:metrics'); json(res, 200, { data: await drainOutbox(store) }); return; }
  if (method === 'GET' && path === '/v1/admin/audit') { requirePermission(auth.user, 'audit:read'); const events = await store.read((state) => state.auditEvents.filter((event) => event.tenantId === auth.user.tenantId).map(({ metadata, ...event }) => ({ ...event, metadata }))); json(res, 200, { data: events.slice(-200) }); return; }
  throw new DomainError('NOT_FOUND', '资源不存在', 404);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(PORT, () => console.log(`Campus Mind API listening on http://localhost:${PORT}`));
}
