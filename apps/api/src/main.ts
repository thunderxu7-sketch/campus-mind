import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXlsxBase64 } from './domain/spreadsheet.js';
import { adminOverview, addFollowUp, acknowledgeCase, approveClosure, approveContent, approveExport, approveFrequencyException, approveProfileSchema, approveReport, approveScale, assignCase, beginAttempt, campaignProgress, commitImport, createAvailabilitySlot, createCampaign, createConsent, createContent, createGuardianLink, createMediaAsset, createProfileSchema, createRiskSignal, createScale, createSelfScreening, currentUser, downloadRightsResult, escalateUnacknowledged, getAttempt, getStudentArchive, listAuditEvents, listAvailableScales, listAvailabilitySlots, listAppointments, listContent, listMyConsents, listMyRightsRequests, listPublicContent, listReports, listScaleCatalog, listStudents, listRightsRequests, operationalStatus, parseCsv, previewImport, publishCampaign, readPublicMedia, regionalAnalytics, requeueDeadLetters, submitProfileResponse, drainOutbox, downloadExport, getAnalytics, listCases, listCampaigns, listMyTasks, requestAppointment, requestClosure, requestExport, reviewCase, saveAnswers, submitAttempt, updateAppointment, updateAvailabilitySlot, updateCampaignState, revokeReport, revokeScale, verifyGuardianLink, withdrawConsent, completeRightsRequest, createRightsRequest, retireContent, processRetention } from './domain/service.js';
import { cancelSupportRequest, createExpressionEntry, createExpressionShare, createSupportRequest, deleteExpressionEntry, escalateSupportRequests, expressionCapabilities, getExpressionEntry, getExpressionNotice, getProfessionalExpressionShare, getSupportRequest, listExpressionEntries, listExpressionShares, listProfessionalExpressionShares, listProfessionalSupportRequests, listSupportEscalations, listSupportNotes, listSupportRecipients, listMySupportRequests, revokeExpressionShare, transitionSupportRequest, addSupportNote } from './domain/expression-support.js';
import { authenticate, issueStudentAccessCode, login as loginUser, loginWithStudentAccessCode, logout, requirePermission, revokeUserSessions } from './domain/auth.js';
import { assertProductionConfig } from './domain/crypto.js';
import { DomainError } from './domain/errors.js';
import { assertProductionStoreInjection, JsonStore } from './domain/store.js';
import type { Store } from './domain/store.js';
import { seedDemoState } from './domain/seed.js';
import type { AuthenticatedUser, DatabaseState } from './domain/types.js';
import { EncryptedFileObjectStore } from './infra/object-store.js';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_FILE = process.env.CAMPMIND_DATA_FILE ?? resolve(process.cwd(), 'private-data/demo-store.json');
const OBJECTS_DIR = process.env.CAMPMIND_OBJECTS_DIR ?? resolve(process.cwd(), 'private-data/objects');
const MAX_BODY_BYTES = 3_000_000;
const loginRate = new Map<string, { count: number; resetAt: number }>();
const LOGIN_RATE_LIMIT = 20;
const LOGIN_RATE_WINDOW_MS = 60_000;

function enforceLoginRateLimit(req: IncomingMessage, res: ServerResponse): void {
  const key = req.socket.remoteAddress ?? 'unknown';
  const timestamp = Date.now();
  let current = loginRate.get(key);
  if (!current || current.resetAt <= timestamp) {
    // Bound the in-process reference map so spoofed/short-lived client
    // addresses cannot grow it without limit. A production edge should also
    // enforce the same policy before the application receives the request.
    if (loginRate.size > 10_000) for (const [address, entry] of loginRate) if (entry.resetAt <= timestamp) loginRate.delete(address);
    current = { count: 0, resetAt: timestamp + LOGIN_RATE_WINDOW_MS };
    loginRate.set(key, current);
  }
  current.count += 1;
  res.setHeader('X-RateLimit-Limit', LOGIN_RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, LOGIN_RATE_LIMIT - current.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(current.resetAt / 1000));
  if (current.count > LOGIN_RATE_LIMIT) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((current.resetAt - timestamp) / 1000)));
    throw new DomainError('RATE_LIMITED', '登录请求过于频繁，请稍后重试', 429);
  }
}

function loadStore(): JsonStore {
  assertProductionStoreInjection();
  const objectStore = new EncryptedFileObjectStore({ rootDir: OBJECTS_DIR });
  if (!existsSync(DATA_FILE) && process.env.NODE_ENV !== 'production') {
    mkdirSync(resolve(DATA_FILE, '..'), { recursive: true, mode: 0o700 });
    return new JsonStore({ filePath: DATA_FILE, initial: seedDemoState(), objectStore });
  }
  return new JsonStore({ filePath: DATA_FILE, objectStore });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function headers(res: ServerResponse, allowStudentVisual = false): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', allowStudentVisual ? 'camera=(self), microphone=(), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof DomainError) {
    json(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }
  // Keep unexpected errors out of logs when they may include decrypted input or request data.
  console.error('internal error', error instanceof Error ? error.name : 'unknown');
  json(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请联系学校支持人员。' } });
}

async function body(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new DomainError('REQUEST_TOO_LARGE', '请求内容过大', 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch { throw new DomainError('INVALID_JSON', '请求 JSON 无效'); }
}

function requestIdempotencyKey(req: IncomingMessage, input: Record<string, unknown>): unknown {
  const header = req.headers['idempotency-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && typeof header[0] === 'string' && header[0].trim()) return header[0].trim();
  return input.idempotencyKey;
}

function assertAllowedFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unexpected) throw new DomainError('EXPRESSION_INPUT_INVALID', `不支持字段 ${unexpected}`);
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

/** Bearer authentication is primary, but reject cross-site state changes as a
 * second line of defence for browser integrations and future cookie sessions. */
function enforceSameOrigin(req: IncomingMessage, method: string, url: URL): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const configured = (process.env.CAMPMIND_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const allowed = new Set(configured.length ? configured : [`http://${req.headers.host ?? 'localhost'}`, `https://${req.headers.host ?? 'localhost'}`, url.origin]);
  if (!allowed.has(origin)) throw new DomainError('CSRF_ORIGIN_INVALID', '请求来源不受信任', 403);
}

function publicScale(scale: DatabaseState['scales'][number]): Record<string, unknown> {
  return { id: scale.id, code: scale.code, title: scale.title, version: scale.version, provenance: scale.provenance, minAge: scale.minAge, maxAge: scale.maxAge, noticeVersion: scale.noticeVersion, dimensions: scale.dimensions ?? [], population: scale.population ?? 'mixed', language: scale.language ?? 'zh-CN', items: scale.items.map((item) => ({ id: item.id, prompt: item.prompt, min: item.min, max: item.max, factor: item.factor })) };
}

export interface AppOptions { store?: Store; }

export function createApp(options: AppOptions = {}) {
  assertProductionConfig();
  assertProductionStoreInjection(options.store);
  const store = options.store ?? loadStore();
  const server = createServer(async (req, res) => {
    // Apply the restrictive baseline before parsing the request.  The exact
    // student-page exception is applied below only after the normalized path
    // and feature flags have both been verified.
    headers(res);
    res.setHeader('X-Request-Id', randomUUID());
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (method === 'GET' && path === '/student' && process.env.CAMPMIND_EXPRESSION_ENABLED === 'true' && process.env.CAMPMIND_VISUAL_DEPLOYMENT_ENABLED === 'true') headers(res, true);
      enforceSameOrigin(req, method, url);
      if (method === 'POST' && path === '/v1/auth/login') {
        enforceLoginRateLimit(req, res);
      }
      if (method === 'GET' && path === '/health') { json(res, 200, { status: 'ok', service: 'campus-mind-api', version: '0.1.0', demo: process.env.NODE_ENV !== 'production' }); return; }
      if (method === 'GET' && (path === '/' || path === '/admin' || path === '/student' || path === '/student/visual-interaction.js')) { servePage(res, path); return; }
      if (path.startsWith('/v1/')) await routeApi(req, res, method, path, url, store);
      else json(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
    } catch (error) { sendError(res, error); }
  });
  return server;
}

function servePage(res: ServerResponse, path: string): void {
  if (path === '/student/visual-interaction.js') {
    const visualScript = resolve(process.cwd(), 'apps/student-web/visual-interaction.js');
    if (!existsSync(visualScript)) throw new DomainError('NOT_FOUND', '资源不存在', 404);
    res.statusCode = 200; res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(readFileSync(visualScript)); return;
  }
  const file = path === '/admin' ? 'apps/admin-web/index.html' : path === '/student' ? 'apps/student-web/index.html' : 'README.md';
  const fullPath = resolve(process.cwd(), file);
  if (path === '/') { json(res, 200, { service: 'campus-mind', links: { admin: '/admin', student: '/student', health: '/health' }, notice: '开发演示，不连接真实学生资料。' }); return; }
  res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(readFileSync(fullPath));
}

async function getAuth(req: IncomingMessage, store: Store): Promise<AuthenticatedUser> {
  return authenticate(store, req.headers.authorization);
}

async function routeApi(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL, store: Store): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const expressionRoute = path.startsWith('/v1/me/expression') || path.startsWith('/v1/me/support') || path.startsWith('/v1/professional/expression') || path.startsWith('/v1/professional/support') || path === '/v1/admin/operations/support-escalate';
  const input = method !== 'GET' && method !== 'DELETE' ? await body(req, expressionRoute ? 8_192 : MAX_BODY_BYTES) : {};
  if (method === 'GET' && path === '/v1/content/public') { json(res, 200, { data: await listPublicContent(store, url.searchParams.has('age') ? Number(url.searchParams.get('age')) : undefined) }); return; }
  if (method === 'GET' && segments[1] === 'content' && segments[2] === 'public' && segments[4] === 'media') {
    const media = await readPublicMedia(store, segments[3]!);
    res.statusCode = 200; res.setHeader('Content-Type', media.mediaType); res.setHeader('Content-Length', media.bytes.byteLength);
    // Do not let a browser/CDN keep a copy after content is retired or its
    // backing object is revoked. Public education content is intentionally
    // revalidated through the publication check on every request.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="${media.filename.replace(/"/g, '')}"`); res.end(media.bytes); return;
  }
  if (method === 'POST' && path === '/v1/auth/login') {
    const result = typeof input.accessCode === 'string' ? await loginWithStudentAccessCode(store, input.accessCode.trim()) : await loginUser(store, stringField(input, 'email'), stringField(input, 'password'), typeof input.mfaCode === 'string' ? input.mfaCode : undefined);
    json(res, 200, { data: result }); return;
  }
  if (method === 'POST' && path === '/v1/auth/logout') {
    const auth = await getAuth(req, store); await logout(store, auth.session); json(res, 204, {}); return;
  }
  const auth = await getAuth(req, store);
  if (method === 'GET' && path === '/v1/me') { json(res, 200, { data: await currentUser(store, auth) }); return; }
  // Student-led expression and support workflows. These routes deliberately
  // expose metadata by default; encrypted text is returned only to the owner
  // or the explicitly selected professional recipient.
  if (method === 'GET' && path === '/v1/me/expression-capabilities') { json(res, 200, { data: await expressionCapabilities(store, auth) }); return; }
  if (method === 'GET' && segments[1] === 'me' && segments[2] === 'expression-notices' && segments.length === 4) {
    const purpose = segments[3] === 'self_expression' || segments[3] === 'visual_interaction' ? segments[3] : undefined;
    if (!purpose) throw new DomainError('NOT_FOUND', '资源不存在', 404);
    json(res, 200, { data: await getExpressionNotice(store, auth, purpose) }); return;
  }
  if (method === 'GET' && path === '/v1/me/support-recipients') { json(res, 200, { data: await listSupportRecipients(store, auth) }); return; }
  if (method === 'POST' && path === '/v1/me/expression-entries') {
    assertAllowedFields(input, ['topic', 'note', 'noticeVersion', 'acknowledged', 'idempotencyKey']);
    const result = await createExpressionEntry(store, auth, { topic: input.topic, note: input.note, noticeVersion: input.noticeVersion, acknowledged: input.acknowledged, idempotencyKey: requestIdempotencyKey(req, input) });
    json(res, result.created ? 201 : 200, { data: result.entry }); return;
  }
  if (method === 'GET' && path === '/v1/me/expression-entries') { json(res, 200, { data: await listExpressionEntries(store, auth) }); return; }
  if (method === 'GET' && segments[1] === 'me' && segments[2] === 'expression-entries' && segments.length === 4) { json(res, 200, { data: await getExpressionEntry(store, auth, segments[3]!) }); return; }
  if (method === 'DELETE' && segments[1] === 'me' && segments[2] === 'expression-entries' && segments.length === 4) { await deleteExpressionEntry(store, auth, segments[3]!); json(res, 204, {}); return; }
  if (method === 'POST' && segments.length === 5 && segments[1] === 'me' && segments[2] === 'expression-entries' && segments[4] === 'shares') {
    assertAllowedFields(input, ['recipientId', 'ttlHours', 'noticeVersion', 'acknowledged', 'idempotencyKey']);
    const result = await createExpressionShare(store, auth, { entryId: segments[3]!, recipientId: stringField(input, 'recipientId'), ttlHours: input.ttlHours, noticeVersion: input.noticeVersion, acknowledged: input.acknowledged, idempotencyKey: requestIdempotencyKey(req, input) });
    json(res, result.created ? 201 : 200, { data: result.share }); return;
  }
  if (method === 'GET' && path === '/v1/me/expression-shares') { json(res, 200, { data: await listExpressionShares(store, auth) }); return; }
  if (method === 'POST' && segments.length === 5 && segments[1] === 'me' && segments[2] === 'expression-shares' && segments[4] === 'revoke') { await revokeExpressionShare(store, auth, segments[3]!); json(res, 204, {}); return; }
  if (method === 'GET' && path === '/v1/professional/expression-shares') { json(res, 200, { data: await listProfessionalExpressionShares(store, auth) }); return; }
  if (method === 'GET' && segments[1] === 'professional' && segments[2] === 'expression-shares' && segments.length === 4) { json(res, 200, { data: await getProfessionalExpressionShare(store, auth, segments[3]!) }); return; }
  if (method === 'POST' && path === '/v1/me/support-requests') {
    assertAllowedFields(input, ['recipientId', 'shareId', 'noticeVersion', 'acknowledged', 'idempotencyKey']);
    const result = await createSupportRequest(store, auth, { recipientId: stringField(input, 'recipientId'), shareId: input.shareId, noticeVersion: input.noticeVersion, acknowledged: input.acknowledged, idempotencyKey: requestIdempotencyKey(req, input) });
    json(res, result.created ? 201 : 200, { data: result.request }); return;
  }
  if (method === 'GET' && path === '/v1/me/support-requests') { json(res, 200, { data: await listMySupportRequests(store, auth) }); return; }
  if (method === 'GET' && segments[1] === 'me' && segments[2] === 'support-requests' && segments.length === 4) { json(res, 200, { data: await getSupportRequest(store, auth, segments[3]!) }); return; }
  if (method === 'POST' && segments.length === 5 && segments[1] === 'me' && segments[2] === 'support-requests' && segments[4] === 'cancel') { assertAllowedFields(input, ['expectedVersion']); const result = await cancelSupportRequest(store, auth, segments[3]!, Number(input.expectedVersion)); json(res, 200, { data: result }); return; }
  if (method === 'GET' && path === '/v1/professional/support-requests') { json(res, 200, { data: await listProfessionalSupportRequests(store, auth) }); return; }
  if (method === 'GET' && segments[1] === 'professional' && segments[2] === 'support-requests' && segments.length === 4) { json(res, 200, { data: await getSupportRequest(store, auth, segments[3]!) }); return; }
  if (method === 'POST' && segments.length === 5 && segments[1] === 'professional' && segments[2] === 'support-requests' && segments[4] === 'transitions') {
    assertAllowedFields(input, ['action', 'expectedVersion', 'nextFollowUpAt']);
    const action = input.action;
    if (action !== 'acknowledge' && action !== 'start' && action !== 'follow_up' && action !== 'complete') throw new DomainError('INVALID_STATE_TRANSITION', '状态转换不受支持', 422);
    const result = await transitionSupportRequest(store, auth, segments[3]!, { action, expectedVersion: Number(input.expectedVersion), nextFollowUpAt: input.nextFollowUpAt });
    json(res, 200, { data: result }); return;
  }
  if (method === 'GET' && segments.length === 5 && segments[1] === 'professional' && segments[2] === 'support-requests' && segments[4] === 'notes') { json(res, 200, { data: await listSupportNotes(store, auth, segments[3]!) }); return; }
  if (method === 'POST' && segments.length === 5 && segments[1] === 'professional' && segments[2] === 'support-requests' && segments[4] === 'notes') {
    assertAllowedFields(input, ['note', 'idempotencyKey']);
    const result = await addSupportNote(store, auth, segments[3]!, { note: input.note, idempotencyKey: requestIdempotencyKey(req, input) });
    const { created: _created, ...publicResult } = result;
    json(res, result.created ? 201 : 200, { data: publicResult }); return;
  }
  if (method === 'GET' && path === '/v1/professional/support-escalations') { json(res, 200, { data: await listSupportEscalations(store, auth) }); return; }
  if (method === 'POST' && path === '/v1/admin/student-credentials') {
    const result = await issueStudentAccessCode(store, auth, stringField(input, 'studentId'), input.ttlMinutes === undefined ? undefined : Number(input.ttlMinutes));
    json(res, 201, { data: { ...result, note: '凭证仅显示一次；请通过学校批准的线下渠道交给对应学生。' } }); return;
  }
  if (method === 'POST' && segments[1] === 'admin' && segments[2] === 'users' && segments[4] === 'sessions' && segments[5] === 'revoke') {
    const result = await revokeUserSessions(store, auth, segments[3]!);
    json(res, 200, { data: result }); return;
  }
  if (method === 'GET' && path === '/v1/admin/students') { json(res, 200, { data: await listStudents(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/campaigns') { json(res, 200, { data: await listCampaigns(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/scales') {
    const status = url.searchParams.get('status');
    const population = url.searchParams.get('population');
    const queryAge = (name: string): number | undefined => {
      const value = url.searchParams.get(name);
      return value === null || value === '' ? undefined : Number(value);
    };
    const filters = {
      ...(status ? { status: status as 'draft' | 'approved' | 'revoked' } : {}),
      ...(population ? { population: population as 'primary' | 'middle' | 'high' | 'mixed' } : {}),
      minAge: queryAge('minAge'),
      maxAge: queryAge('maxAge'),
    };
    json(res, 200, { data: await listScaleCatalog(store, auth, filters) }); return;
  }
  if (method === 'GET' && path === '/v1/me/tasks') { json(res, 200, { data: await listMyTasks(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/availability-slots') { json(res, 200, { data: await listAvailabilitySlots(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/appointments') { json(res, 200, { data: await listAppointments(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/content') { json(res, 200, { data: await listContent(store, auth) }); return; }
  if (method === 'GET' && segments[1] === 'students' && segments[3] === 'archive') { json(res, 200, { data: await getStudentArchive(store, auth, segments[2]!, url.searchParams.get('purpose') ?? '') }); return; }
  if (method === 'GET' && segments[1] === 'rights-requests' && segments[3] === 'result') { json(res, 200, { data: await downloadRightsResult(store, auth, segments[2]!) }); return; }
  if (method === 'GET' && path === '/v1/me/rights-requests') { json(res, 200, { data: await listMyRightsRequests(store, auth) }); return; }
  if (method === 'POST' && path === '/v1/me/consents') {
    const result = await createConsent(store, auth, { studentId: stringField(input, 'studentId'), actorType: (input.actorType as 'student' | 'guardian' | 'school_legal_basis') ?? 'student', noticeVersion: stringField(input, 'noticeVersion'), purpose: (input.purpose as 'assessment' | 'support' | 'research' | 'self_expression' | 'visual_interaction') ?? 'assessment' });
    json(res, 201, { data: result }); return;
  }
  if (method === 'GET' && path === '/v1/me/consents') { json(res, 200, { data: await listMyConsents(store, auth, url.searchParams.get('purpose') ?? undefined) }); return; }
  if (method === 'POST' && path === '/v1/guardian-links') { const result = await createGuardianLink(store, auth, stringField(input, 'studentId'), stringField(input, 'guardianUserId')); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'guardian-links' && segments[3] === 'verify') { const result = await verifyGuardianLink(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
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
    const dimensions = Array.isArray(input.dimensions) ? input.dimensions.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 20) : undefined;
    const scale = await createScale(store, auth, { code: stringField(input, 'code'), title: stringField(input, 'title'), version: stringField(input, 'version'), provenance: (input.provenance as 'synthetic_only' | 'licensed') ?? 'synthetic_only', minAge: Number(input.minAge), maxAge: Number(input.maxAge), scoringVersion: stringField(input, 'scoringVersion'), noticeVersion: stringField(input, 'noticeVersion'), dimensions, population: input.population as 'primary' | 'middle' | 'high' | 'mixed' | undefined, language: typeof input.language === 'string' ? input.language.trim() : undefined, licenseExpiresAt: typeof input.licenseExpiresAt === 'string' ? input.licenseExpiresAt : undefined, reviewEvidenceRef: typeof input.reviewEvidenceRef === 'string' ? input.reviewEvidenceRef.trim() : undefined, items: arrayField(input, 'items') as never, warningRule: input.warningRule as never }); json(res, 201, { data: publicScale(scale) }); return;
  }
  if (method === 'POST' && segments[1] === 'scales' && segments[3] === 'approve') { const scale = await approveScale(store, auth, segments[2]!); json(res, 200, { data: publicScale(scale) }); return; }
  if (method === 'POST' && segments[1] === 'scales' && segments[3] === 'revoke') { await revokeScale(store, auth, segments[2]!, stringField(input, 'reason')); json(res, 204, {}); return; }
  if (method === 'POST' && path === '/v1/campaigns') {
    const ids = arrayField(input, 'participantStudentIds').map((value) => String(value));
    const campaign = await createCampaign(store, auth, { schoolId: stringField(input, 'schoolId'), name: stringField(input, 'name'), purpose: (input.purpose as 'screening' | 'survey') ?? 'screening', academicYear: stringField(input, 'academicYear'), opensAt: stringField(input, 'opensAt'), closesAt: stringField(input, 'closesAt'), scaleVersionId: stringField(input, 'scaleVersionId'), participantStudentIds: ids }); json(res, 201, { data: campaign }); return;
  }
  if (method === 'POST' && segments[1] === 'campaigns' && segments[3] === 'publish') { const campaign = await publishCampaign(store, auth, segments[2]!); json(res, 200, { data: campaign }); return; }
  if (method === 'POST' && segments[1] === 'campaigns' && segments[3] === 'frequency-exceptions') { const reservation = await approveFrequencyException(store, auth, segments[2]!, { studentId: stringField(input, 'studentId'), reason: stringField(input, 'reason') }); json(res, 201, { data: reservation }); return; }
  if (method === 'GET' && segments[1] === 'campaigns' && segments[3] === 'progress') { const progress = await campaignProgress(store, auth, segments[2]!); json(res, 200, { data: progress }); return; }
  if (method === 'POST' && segments[1] === 'campaigns' && segments[3] === 'state') { const campaign = await updateCampaignState(store, auth, segments[2]!, (input.state as 'draft' | 'approved' | 'scheduled' | 'open' | 'paused' | 'closed' | 'cancelled' | 'archived') ?? 'paused'); json(res, 200, { data: campaign }); return; }
  if (method === 'GET' && path === '/v1/me/scales') {
    const scales = await listAvailableScales(store, auth); json(res, 200, { data: scales }); return;
  }
  if (method === 'POST' && segments[1] === 'me' && segments[2] === 'tasks' && segments[4] === 'attempts') { const result = await beginAttempt(store, auth, segments[3]!); json(res, 201, { data: { attempt: result.attempt, scale: publicScale(result.scale) } }); return; }
  if (method === 'GET' && segments[1] === 'attempts' && segments.length === 3) { json(res, 200, { data: await getAttempt(store, auth, segments[2]!) }); return; }
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
  if (method === 'POST' && segments[1] === 'reports' && segments[3] === 'revoke') { await revokeReport(store, auth, segments[2]!, stringField(input, 'reason')); json(res, 204, {}); return; }
  if (method === 'POST' && path === '/v1/risk-signals') { const riskCase = await createRiskSignal(store, auth, { studentId: stringField(input, 'studentId'), level: (input.level as 'attention' | 'urgent') ?? 'attention', reason: stringField(input, 'reason'), source: input.source as never }); json(res, 201, { data: riskCase }); return; }
  if (method === 'GET' && path === '/v1/cases') { json(res, 200, { data: await listCases(store, auth) }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'reviews') { const result = await reviewCase(store, auth, segments[2]!, { decision: input.decision as 'dismiss' | 'confirm', note: stringField(input, 'note') }); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'assign') { const result = await assignCase(store, auth, segments[2]!, stringField(input, 'assigneeId')); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'acknowledgements') { const result = await acknowledgeCase(store, auth, segments[2]!); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'follow-ups') { const result = await addFollowUp(store, auth, segments[2]!, { kind: (input.kind as 'support' | 'referral' | 'follow_up') ?? 'support', note: stringField(input, 'note'), dueAt: typeof input.dueAt === 'string' ? input.dueAt : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'closure-requests') { const result = await requestClosure(store, auth, segments[2]!, stringField(input, 'reason')); json(res, 200, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'cases' && segments[3] === 'closure-approvals') { const result = await approveClosure(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/rights-requests') { const result = await createRightsRequest(store, auth, { studentId: stringField(input, 'studentId'), kind: (input.kind as 'access' | 'correct' | 'delete' | 'withdraw') ?? 'access', reason: typeof input.reason === 'string' ? input.reason : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'GET' && path === '/v1/admin/rights-requests') { json(res, 200, { data: await listRightsRequests(store, auth) }); return; }
  if (method === 'POST' && segments[1] === 'admin' && segments[2] === 'rights-requests' && segments[4] === 'complete') { const result = await completeRightsRequest(store, auth, segments[3]!, input.decision === 'reject' ? 'reject' : 'complete', typeof input.decisionReason === 'string' ? input.decisionReason : undefined); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/exports') { const result = await requestExport(store, auth, { kind: input.kind as 'aggregate' | 'report', studentId: typeof input.studentId === 'string' ? input.studentId : undefined, purpose: input.purpose === undefined ? undefined : input.purpose as string }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'exports' && segments[3] === 'approve') { const result = await approveExport(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'GET' && segments[1] === 'exports' && (segments.length === 3 || (segments.length === 4 && segments[3] === 'download'))) { const result = await downloadExport(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'GET' && path === '/v1/analytics/summary') { json(res, 200, { data: await getAnalytics(store, auth, url.searchParams.get('groupBy') ?? 'school') }); return; }
  if (method === 'POST' && path === '/v1/profile-schemas') { const result = await createProfileSchema(store, auth, { version: stringField(input, 'version'), fields: arrayField(input, 'fields') as never }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && segments[1] === 'profile-schemas' && segments[3] === 'approve') { const result = await approveProfileSchema(store, auth, segments[2]!); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/availability-slots') { const result = await createAvailabilitySlot(store, auth, { counselorId: stringField(input, 'counselorId'), startsAt: stringField(input, 'startsAt'), endsAt: stringField(input, 'endsAt'), room: typeof input.room === 'string' ? input.room : undefined }); json(res, 201, { data: result }); return; }
  if (method === 'POST' && path === '/v1/appointments') {
    const result = await requestAppointment(store, auth, { slotId: stringField(input, 'slotId'), note: typeof input.note === 'string' ? input.note : undefined, idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined });
    // Never return the encrypted note or the idempotency material. The client
    // only needs the booking reference and state to render a receipt.
    json(res, 201, { data: { id: result.id, state: result.state, createdAt: result.createdAt, updatedAt: result.updatedAt } }); return;
  }
  if (method === 'POST' && segments[1] === 'appointments' && segments[3] === 'state') {
    const result = await updateAppointment(store, auth, segments[2]!, (input.state as 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show') ?? 'cancelled');
    json(res, 200, { data: { id: result.id, state: result.state, createdAt: result.createdAt, updatedAt: result.updatedAt } }); return;
  }
  if (method === 'POST' && segments[1] === 'availability-slots' && segments[3] === 'state') { const result = await updateAvailabilitySlot(store, auth, segments[2]!, input.status as 'available' | 'blocked'); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/content') { const result = await createContent(store, auth, { title: stringField(input, 'title'), kind: (input.kind as 'article' | 'announcement' | 'media') ?? 'article', body: stringField(input, 'body'), ageMin: Number(input.ageMin), ageMax: Number(input.ageMax), copyrightSource: stringField(input, 'copyrightSource'), mediaAssetId: typeof input.mediaAssetId === 'string' ? input.mediaAssetId : undefined, altText: typeof input.altText === 'string' ? input.altText : undefined, captionText: typeof input.captionText === 'string' ? input.captionText : undefined }); json(res, 201, { data: { ...result, bodyCiphertext: undefined } }); return; }
  if (method === 'POST' && path === '/v1/media-assets') { const result = await createMediaAsset(store, auth, { filename: stringField(input, 'filename'), mediaType: stringField(input, 'mediaType'), base64: stringField(input, 'base64') }); json(res, 201, { data: { id: result.id, filename: result.filename, mediaType: result.mediaType, kind: result.kind, byteSize: result.byteSize, sha256: result.sha256, scanStatus: result.scanStatus, createdAt: result.createdAt } }); return; }
  if (method === 'POST' && segments[1] === 'content' && segments[3] === 'publish') { const result = await approveContent(store, auth, segments[2]!); json(res, 200, { data: { id: result.id, state: result.state, publishedAt: result.publishedAt } }); return; }
  if (method === 'POST' && segments[1] === 'content' && segments[3] === 'retire') { const result = await retireContent(store, auth, segments[2]!); json(res, 200, { data: { id: result.id, state: result.state } }); return; }
  if (method === 'GET' && path === '/v1/admin/regional-analytics') { json(res, 200, { data: await regionalAnalytics(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/overview') { json(res, 200, { data: await adminOverview(store, auth) }); return; }
  if (method === 'GET' && path === '/v1/admin/operations/status') { json(res, 200, { data: await operationalStatus(store, auth) }); return; }
  if (method === 'POST' && path === '/v1/admin/operations/requeue-dead-letters') { const result = await requeueDeadLetters(store, auth, input.limit === undefined ? 50 : Number(input.limit)); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/admin/operations/escalate') { const result = await escalateUnacknowledged(store, auth, { asOf: typeof input.asOf === 'string' ? input.asOf : undefined, thresholdMinutes: Number(input.thresholdMinutes) }); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/admin/operations/support-escalate') { assertAllowedFields(input, ['asOf']); const result = await escalateSupportRequests(store, auth, typeof input.asOf === 'string' ? input.asOf : undefined); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/admin/retention/run') { const result = await processRetention(store, auth, typeof input.asOf === 'string' ? input.asOf : undefined); json(res, 200, { data: result }); return; }
  if (method === 'POST' && path === '/v1/admin/worker/drain') { requirePermission(auth.user, 'system:metrics'); json(res, 200, { data: await drainOutbox(store) }); return; }
  if (method === 'GET' && path === '/v1/admin/audit') { json(res, 200, { data: await listAuditEvents(store, auth, url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined) }); return; }
  throw new DomainError('NOT_FOUND', '资源不存在', 404);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(PORT, () => console.log(`Campus Mind API listening on http://localhost:${PORT}`));
}
