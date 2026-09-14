import { createHmac, randomUUID } from 'node:crypto';
import { can, isProfessional, isStudent } from './auth.js';
import { decrypt, encrypt } from './crypto.js';
import { DomainError, forbidden, notFound } from './errors.js';
import type { Store } from './store.js';
import type {
  AuthenticatedUser, ConsentRecord, DatabaseState, ExpressionEntry, ExpressionNotice, ExpressionPolicy, ExpressionPurpose,
  ExpressionRevocation, ExpressionShare, ExpressionShareState, ExpressionTopic, SupportCancellationReason, SupportNote,
  SupportRequest, SupportRequestState, SupportTransition, User,
} from './types.js';

const id = () => randomUUID();
const now = () => new Date().toISOString();
const EXPRESSION_PURPOSES: readonly ExpressionPurpose[] = ['self_expression', 'visual_interaction'];
const TOPICS: readonly ExpressionTopic[] = ['study', 'peers', 'family', 'school_life', 'general'];
const NON_TERMINAL_SUPPORT: readonly SupportRequestState[] = ['requested', 'acknowledged', 'in_contact', 'follow_up'];
const IDENTITY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const expressionDeploymentEnabled = () => process.env.NODE_ENV !== 'production' || process.env.CAMPMIND_EXPRESSION_ENABLED === 'true';
const visualDeploymentEnabled = () => process.env.CAMPMIND_EXPRESSION_ENABLED === 'true' && process.env.CAMPMIND_VISUAL_DEPLOYMENT_ENABLED === 'true';
const validDateString = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export type PublicExpressionEntry = {
  id: string;
  source: 'student_self_report';
  topic?: ExpressionTopic;
  note?: string;
  createdAt: string;
  expiresAt: string;
};

export type PublicExpressionEntryMeta = {
  id: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
  shareStatus: ExpressionShareState | 'none';
};

export type PublicExpressionShare = {
  id: string;
  entryId: string;
  recipientId: string;
  status: ExpressionShareState;
  createdAt: string;
  expiresAt: string;
};

export type PublicSupportRequest = {
  id: string;
  studentId: string;
  recipientId: string;
  shareId?: string;
  state: SupportRequestState;
  version: number;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  ackDueAt: string;
  firstAcknowledgedAt?: string;
  nextFollowUpAt?: string;
  closedAt?: string;
  cancellationReason?: SupportCancellationReason;
  recipientAvailable: boolean;
  shareAccessible: boolean;
};

export type ExpressionCapabilities = {
  expressionEnabled: boolean;
  visualEnabled: boolean;
  noticeVersions: { selfExpression: string | null; visualInteraction: string | null };
  consentRequirements: { selfExpression: boolean; visualInteraction: boolean; guardianForUnder14: boolean };
  serviceHoursText: string | null;
  contactInstructions: string | null;
  allowedShareHours: number[];
  validForSeconds: 45;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digestKey(): { key: string; version: string } {
  // This is a reference adapter fallback only. Production configuration is
  // already fail-closed by assertProductionConfig and must provide a secret.
  const key = process.env.CAMPMIND_MASTER_KEY ?? 'campus-mind-reference-idempotency-key';
  const version = process.env.CAMPMIND_IDEMPOTENCY_KEY_VERSION?.trim() || 'master-v1';
  return { key, version };
}

function requestDigest(scope: string, tenantId: string, actorId: string, body: unknown): { digest: string; version: string } {
  const material = stableJson({ scope, tenantId, actorId, body });
  const active = digestKey();
  return { digest: createHmac('sha256', active.key).update(material).digest('hex'), version: active.version };
}

function requireIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDENTITY_KEY_PATTERN.test(key.trim())) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '需要 16–128 位 ASCII 幂等键');
  return key.trim();
}

function textField(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DomainError('EXPRESSION_INPUT_INVALID', `${field} 不能为空`);
    return undefined;
  }
  if (typeof value !== 'string') throw new DomainError('EXPRESSION_INPUT_INVALID', `${field} 必须是文本`);
  const text = value.trim();
  if (!text || text.length > max || Array.from(text).length > max || CONTROL_CHARACTERS.test(text)) throw new DomainError('EXPRESSION_INPUT_INVALID', `${field} 格式或长度无效`);
  return text;
}

function policyForStudent(state: DatabaseState, student: { tenantId: string; schoolId: string }): ExpressionPolicy | undefined {
  return state.expressionPolicies.find((policy) => policy.tenantId === student.tenantId && policy.schoolId === student.schoolId);
}

function policyShapeValid(policy: ExpressionPolicy): boolean {
  const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value);
  return boundedText(policy.policyVersion, 80)
    && boundedText(policy.selfExpressionNoticeVersion, 80)
    && boundedText(policy.visualNoticeVersion, 80)
    && Array.isArray(policy.counselorIds) && policy.counselorIds.length > 0 && policy.counselorIds.every((id) => typeof id === 'string' && id.length > 0)
    && boundedText(policy.serviceHoursText, 500) && boundedText(policy.contactInstructions, 1000)
    && Number.isInteger(policy.ackTargetMinutes) && policy.ackTargetMinutes >= 5 && policy.ackTargetMinutes <= 1440
    && Number.isInteger(policy.entryRetentionDays) && policy.entryRetentionDays >= 1 && policy.entryRetentionDays <= 3650
    && Number.isInteger(policy.closedRequestRetentionDays) && policy.closedRequestRetentionDays >= 1 && policy.closedRequestRetentionDays <= 3650
    && Number.isInteger(policy.accessLedgerRetentionDays) && policy.accessLedgerRetentionDays >= 30 && policy.accessLedgerRetentionDays <= 3650
    && Number.isInteger(policy.maxShareHours) && policy.maxShareHours >= 1 && policy.maxShareHours <= 168
    && Number.isInteger(policy.maxOpenRequestsPerStudent) && policy.maxOpenRequestsPerStudent >= 1 && policy.maxOpenRequestsPerStudent <= 20
    && Number.isInteger(policy.minAge) && Number.isInteger(policy.maxAge) && policy.minAge >= 6 && policy.maxAge <= 19 && policy.minAge <= policy.maxAge
    && validDateString(policy.createdAt)
    && (!policy.enabled || validDateString(policy.approvedAt));
}

function noticeShapeValid(notice: ExpressionNotice): boolean {
  const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value);
  return notice.approved && boundedText(notice.version, 80) && boundedText(notice.title, 200) && boundedText(notice.body, 5000) && validDateString(notice.createdAt);
}

function studentFor(state: DatabaseState, auth: AuthenticatedUser): { id: string; tenantId: string; schoolId: string; age?: number; active: boolean } {
  if (!isStudent(auth.user)) throw forbidden();
  const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
  if (!student) throw notFound();
  return student;
}

function policyForRequest(state: DatabaseState, auth: AuthenticatedUser, purpose: ExpressionPurpose, allowDisabled = false): { student: ReturnType<typeof studentFor>; policy?: ExpressionPolicy } {
  const student = studentFor(state, auth);
  const policy = policyForStudent(state, student);
  if (!policy && !allowDisabled) throw new DomainError('EXPRESSION_NOT_CONFIGURED', '表达与支持功能尚未配置', 503);
  if (!allowDisabled && policy && (!expressionDeploymentEnabled() || !policyShapeValid(policy) || !policy.enabled || (purpose === 'visual_interaction' && (!policy.visualEnabled || !visualDeploymentEnabled())))) throw new DomainError('EXPRESSION_NOT_CONFIGURED', '该表达功能当前未启用或配置未获批准', 503);
  if (!allowDisabled && policy && (typeof student.age !== 'number' || student.age < policy.minAge || student.age > policy.maxAge)) throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '当前年龄不在已批准适用范围内', 403);
  return { student, policy };
}

function policyForProfessional(state: DatabaseState, auth: AuthenticatedUser): ExpressionPolicy {
  if (!isProfessional(auth.user) || !can(auth.user, 'expression:shared-read')) throw forbidden();
  if (!auth.user.schoolId) throw forbidden();
  const policy = state.expressionPolicies.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.schoolId === auth.user.schoolId && candidate.enabled);
  if (!expressionDeploymentEnabled() || !policy || !policyShapeValid(policy)) throw new DomainError('EXPRESSION_NOT_CONFIGURED', '表达与支持功能尚未配置', 503);
  return policy;
}

/** Clear an entry's encrypted payload and persist the minimal deletion
 * evidence used by backup-restore replay.  Share/request history remains
 * separate; deleting an entry must not erase an independent contact request
 * or professional note. */
export function markExpressionEntryDeleted(state: DatabaseState, entry: ExpressionEntry, deletedAt = now()): void {
  entry.payloadCiphertext = undefined;
  entry.deletedAt ??= deletedAt;
  if (!state.expressionRevocations.some((record) => record.tenantId === entry.tenantId && record.studentId === entry.studentId && record.targetType === 'entry' && record.targetId === entry.id && record.effect === 'delete')) {
    state.expressionRevocations.push({ id: id(), tenantId: entry.tenantId, schoolId: entry.schoolId, studentId: entry.studentId, targetType: 'entry', targetId: entry.id, effect: 'delete', recordedAt: deletedAt });
  }
}

function currentConsent(state: DatabaseState, studentId: string, tenantId: string, purpose: ExpressionPurpose, noticeVersion?: string): ConsentRecord | undefined {
  return state.consents.find((consent) => consent.tenantId === tenantId && consent.studentId === studentId && consent.purpose === purpose && consent.status === 'active' && (!noticeVersion || consent.noticeVersion === noticeVersion));
}

function requireConsent(state: DatabaseState, student: { id: string; tenantId: string; age?: number }, purpose: ExpressionPurpose, noticeVersion: string): ConsentRecord {
  const consent = currentConsent(state, student.id, student.tenantId, purpose, noticeVersion);
  if (!consent) throw new DomainError(purpose === 'visual_interaction' ? 'VISUAL_CONSENT_REQUIRED' : 'EXPRESSION_CONSENT_REQUIRED', '需要当前告知版本的参与记录', 403);
  if (typeof student.age !== 'number') throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '年龄信息未核验，暂不能启用该功能', 403);
  if (student.age < 14 && (consent.actorType !== 'guardian' || !state.guardianLinks.some((link) => link.tenantId === student.tenantId && link.studentId === student.id && link.guardianUserId === consent.actorId && link.status === 'verified'))) throw new DomainError('GUARDIAN_CONSENT_REQUIRED', '不满 14 周岁需要当前核验监护人同意', 403);
  return consent;
}

function requireNotice(state: DatabaseState, policy: ExpressionPolicy, purpose: ExpressionPurpose, version: string): ExpressionNotice {
  const notice = state.expressionNotices.find((candidate) => candidate.tenantId === policy.tenantId && candidate.schoolId === policy.schoolId && candidate.purpose === purpose && candidate.version === version && noticeShapeValid(candidate));
  if (!notice) throw new DomainError('EXPRESSION_NOT_CONFIGURED', '当前告知文本未完成审批', 503);
  return notice;
}

/** Validate a consent creation against the same controlled policy/notice
 * registry used by the feature endpoints.  The generic consent route must not
 * become a way to mint a consent for a disabled or stale extension. */
export function assertExpressionConsentAllowed(state: DatabaseState, student: { tenantId: string; schoolId: string; age?: number }, purpose: ExpressionPurpose, noticeVersion: string): void {
  if (!expressionDeploymentEnabled()) throw new DomainError('EXPRESSION_NOT_CONFIGURED', '表达与支持功能尚未配置', 503);
  const policy = policyForStudent(state, student);
  if (!policy || !policyShapeValid(policy) || !policy.enabled || (purpose === 'visual_interaction' && (!policy.visualEnabled || !visualDeploymentEnabled()))) throw new DomainError('EXPRESSION_NOT_CONFIGURED', '该表达功能当前未启用或配置未获批准', 503);
  if (typeof student.age !== 'number' || student.age < policy.minAge || student.age > policy.maxAge) throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '当前年龄不在已批准适用范围内', 403);
  const expectedVersion = purpose === 'self_expression' ? policy.selfExpressionNoticeVersion : policy.visualNoticeVersion;
  const notice = requireNotice(state, policy, purpose, expectedVersion);
  if (notice.version !== noticeVersion) throw new DomainError('EXPRESSION_NOTICE_CHANGED', '告知版本已更新，请重新阅读', 409);
}

function shareStatus(state: DatabaseState, entry: ExpressionEntry, timestamp = Date.now()): ExpressionShareState | 'none' {
  const share = state.expressionShares.find((candidate) => candidate.tenantId === entry.tenantId && candidate.entryId === entry.id && candidate.status === 'active');
  if (!share) return 'none';
  if (Date.parse(share.expiresAt) <= timestamp) return 'expired';
  return share.status;
}

function isEntryReadable(entry: ExpressionEntry, timestamp = Date.now()): boolean {
  return !entry.deletedAt && Boolean(entry.payloadCiphertext) && Date.parse(entry.expiresAt) > timestamp;
}

function publicEntryMeta(state: DatabaseState, entry: ExpressionEntry): PublicExpressionEntryMeta {
  const result: PublicExpressionEntryMeta = { id: entry.id, createdAt: entry.createdAt, expiresAt: entry.expiresAt, shareStatus: shareStatus(state, entry) };
  if (entry.deletedAt) result.deletedAt = entry.deletedAt;
  return result;
}

function decodeEntry(entry: ExpressionEntry): PublicExpressionEntry {
  if (!isEntryReadable(entry)) throw new DomainError('EXPRESSION_GONE', '表达记录已到期或删除', 410);
  const payload = decrypt<{ topic?: ExpressionTopic; note?: string }>(entry.payloadCiphertext!);
  return { id: entry.id, source: entry.source, ...(payload.topic ? { topic: payload.topic } : {}), ...(payload.note ? { note: payload.note } : {}), createdAt: entry.createdAt, expiresAt: entry.expiresAt };
}

function allowedRecipient(state: DatabaseState, policy: ExpressionPolicy, recipientId: string, schoolId: string, tenantId: string): User | undefined {
  const recipient = state.users.find((candidate) => candidate.id === recipientId && candidate.tenantId === tenantId && candidate.schoolId === schoolId && candidate.active && isProfessional(candidate));
  if (!recipient || !policy.counselorIds.includes(recipient.id)) return undefined;
  return recipient;
}

function publicShare(share: ExpressionShare, status: ExpressionShareState = share.status): PublicExpressionShare {
  return { id: share.id, entryId: share.entryId, recipientId: share.recipientId, status, createdAt: share.createdAt, expiresAt: share.expiresAt };
}

function recipientAvailable(state: DatabaseState, request: SupportRequest): boolean {
  const policy = state.expressionPolicies.find((candidate) => candidate.tenantId === request.tenantId && candidate.schoolId === request.schoolId && candidate.enabled);
  return Boolean(policy && policyShapeValid(policy) && allowedRecipient(state, policy, request.recipientId, request.schoolId, request.tenantId));
}

function shareAccessible(state: DatabaseState, request: SupportRequest): boolean {
  if (!request.shareId) return false;
  const share = state.expressionShares.find((candidate) => candidate.tenantId === request.tenantId && candidate.id === request.shareId && candidate.studentId === request.studentId && candidate.recipientId === request.recipientId && candidate.status === 'active');
  const entry = share && state.expressionEntries.find((candidate) => candidate.tenantId === request.tenantId && candidate.id === share.entryId && candidate.studentId === request.studentId);
  const consent = currentConsent(state, request.studentId, request.tenantId, 'self_expression', request.noticeVersion);
  return Boolean(share && entry && consent && Date.parse(share.expiresAt) > Date.now() && isEntryReadable(entry));
}

function publicSupportRequest(state: DatabaseState, request: SupportRequest): PublicSupportRequest {
  const result: PublicSupportRequest = {
    id: request.id, studentId: request.studentId, recipientId: request.recipientId, state: request.state, version: request.version,
    policyVersion: request.policyVersion, createdAt: request.createdAt, updatedAt: request.updatedAt, ackDueAt: request.ackDueAt,
    recipientAvailable: recipientAvailable(state, request), shareAccessible: shareAccessible(state, request),
  };
  if (request.shareId) result.shareId = request.shareId;
  if (request.firstAcknowledgedAt) result.firstAcknowledgedAt = request.firstAcknowledgedAt;
  if (request.nextFollowUpAt) result.nextFollowUpAt = request.nextFollowUpAt;
  if (request.closedAt) result.closedAt = request.closedAt;
  if (request.cancellationReason) result.cancellationReason = request.cancellationReason;
  return result;
}

function cancelSupportEvent(state: DatabaseState, requestId: string, reason: NonNullable<import('./types.js').OutboxEvent['cancelReasonCode']>): void {
  const cancelledAt = now();
  for (const event of state.outboxEvents.filter((candidate) => candidate.aggregateId === requestId && candidate.status === 'pending' && ['support.request_created', 'support.request_overdue', 'support.follow_up_due'].includes(candidate.type))) {
    event.status = 'cancelled'; event.cancelledAt = cancelledAt; event.cancelReasonCode = reason;
    state.auditEvents.push({ id: id(), tenantId: event.tenantId, action: 'support.notification_cancelled', objectType: 'outbox', objectId: event.id, purpose: 'support', metadata: { reason }, createdAt: cancelledAt });
  }
}

function revokeShareInternal(state: DatabaseState, share: ExpressionShare, effect: 'revoke' = 'revoke'): void {
  if (share.status === 'active') { share.status = 'revoked'; share.revokedAt = now(); }
  const entry = state.expressionEntries.find((candidate) => candidate.tenantId === share.tenantId && candidate.id === share.entryId);
  if (entry && !state.expressionRevocations.some((record) => record.tenantId === share.tenantId && record.targetType === 'share' && record.targetId === share.id && record.effect === effect)) {
    state.expressionRevocations.push({ id: id(), tenantId: share.tenantId, schoolId: share.schoolId, studentId: share.studentId, targetType: 'share', targetId: share.id, effect, recordedAt: now() });
  }
}

/** Apply a purpose withdrawal to the extension without touching assessment data. */
export function revokeExpressionProcessing(state: DatabaseState, tenantId: string, studentId: string, purpose: ExpressionPurpose, consentId: string): void {
  const entries = state.expressionEntries.filter((entry) => entry.tenantId === tenantId && entry.studentId === studentId);
  const schoolId = entries[0]?.schoolId ?? state.students.find((student) => student.tenantId === tenantId && student.id === studentId)?.schoolId;
  if (!schoolId) return;
  if (purpose === 'self_expression') {
    for (const share of state.expressionShares.filter((candidate) => candidate.tenantId === tenantId && candidate.studentId === studentId && candidate.status === 'active')) revokeShareInternal(state, share);
    for (const request of state.supportRequests.filter((candidate) => candidate.tenantId === tenantId && candidate.studentId === studentId && NON_TERMINAL_SUPPORT.includes(candidate.state))) {
      request.state = 'cancelled'; request.cancellationReason = 'consent_withdrawn'; request.closedAt = now(); request.updatedAt = request.closedAt; request.version += 1; cancelSupportEvent(state, request.id, 'consent_revoked');
    }
  }
  if (!state.expressionRevocations.some((record) => record.tenantId === tenantId && record.targetType === 'consent' && record.targetId === consentId)) state.expressionRevocations.push({ id: id(), tenantId, schoolId, studentId, targetType: 'consent', targetId: consentId, effect: 'revoke', recordedAt: now() });
}

export async function expressionCapabilities(store: Store, auth: AuthenticatedUser): Promise<ExpressionCapabilities> {
  if (!isStudent(auth.user)) throw forbidden();
  return store.read((state) => {
    const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
    if (!student) throw notFound();
    const policy = policyForStudent(state, student);
    const ageInRange = Boolean(typeof student.age === 'number' && student.age >= (policy?.minAge ?? 0) && student.age <= (policy?.maxAge ?? 0));
    const validPolicy = Boolean(policy && policyShapeValid(policy) && policy.enabled);
    const selfNotice = policy && state.expressionNotices.find((candidate) => candidate.tenantId === policy.tenantId && candidate.schoolId === policy.schoolId && candidate.purpose === 'self_expression' && candidate.version === policy.selfExpressionNoticeVersion && noticeShapeValid(candidate));
    const visualNotice = policy && state.expressionNotices.find((candidate) => candidate.tenantId === policy.tenantId && candidate.schoolId === policy.schoolId && candidate.purpose === 'visual_interaction' && candidate.version === policy.visualNoticeVersion && noticeShapeValid(candidate));
    const expressionEnabled = Boolean(validPolicy && expressionDeploymentEnabled() && selfNotice && ageInRange);
    const visualEnabled = Boolean(validPolicy && visualNotice && policy?.visualEnabled && visualDeploymentEnabled() && ageInRange);
    return {
      expressionEnabled, visualEnabled,
      noticeVersions: { selfExpression: selfNotice ? policy?.selfExpressionNoticeVersion ?? null : null, visualInteraction: visualNotice ? policy?.visualNoticeVersion ?? null : null },
      consentRequirements: { selfExpression: expressionEnabled, visualInteraction: visualEnabled, guardianForUnder14: typeof student.age === 'number' && student.age < 14 },
      serviceHoursText: expressionEnabled ? policy?.serviceHoursText ?? null : null,
      contactInstructions: expressionEnabled ? policy?.contactInstructions ?? null : null,
      allowedShareHours: expressionEnabled && policy ? [1, 24, 168].filter((hours) => hours <= policy.maxShareHours) : [],
      validForSeconds: 45,
    } satisfies ExpressionCapabilities;
  });
}

export async function getExpressionNotice(store: Store, auth: AuthenticatedUser, purpose: ExpressionPurpose): Promise<Pick<ExpressionNotice, 'purpose' | 'version' | 'title' | 'body'>> {
  if (!EXPRESSION_PURPOSES.includes(purpose)) throw new DomainError('EXPRESSION_INPUT_INVALID', '用途无效');
  return store.read((state) => {
    const { student, policy } = policyForRequest(state, auth, purpose);
    const notice = requireNotice(state, policy!, purpose, purpose === 'self_expression' ? policy!.selfExpressionNoticeVersion : policy!.visualNoticeVersion);
    if (typeof student.age !== 'number' || student.age < policy!.minAge || student.age > policy!.maxAge) throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '当前年龄不在已批准适用范围内', 403);
    return { purpose: notice.purpose, version: notice.version, title: notice.title, body: notice.body };
  });
}

export async function listSupportRecipients(store: Store, auth: AuthenticatedUser): Promise<Array<{ id: string; displayName: string; role: 'counselor' | 'professional_lead'; acceptingRequests: boolean }>> {
  return store.read((state) => {
    const { student, policy } = policyForRequest(state, auth, 'self_expression');
    const recipients = state.users.filter((user) => isProfessional(user) && user.active && user.tenantId === student.tenantId && user.schoolId === student.schoolId && policy!.counselorIds.includes(user.id));
    return recipients.map((user) => ({ id: user.id, displayName: user.displayName, role: user.role === 'professional_lead' ? 'professional_lead' as const : 'counselor' as const, acceptingRequests: true }));
  });
}

export async function createExpressionEntry(store: Store, auth: AuthenticatedUser, input: { topic?: unknown; note?: unknown; noticeVersion: unknown; acknowledged?: unknown; idempotencyKey: unknown }): Promise<{ entry: PublicExpressionEntry; created: boolean }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const topic = input.topic === undefined || input.topic === null || input.topic === '' ? undefined : textField(input.topic, 'topic', 40);
  if (topic && !TOPICS.includes(topic as ExpressionTopic)) throw new DomainError('EXPRESSION_INPUT_INVALID', 'topic 不在允许范围');
  const note = textField(input.note, 'note', 1000);
  if (!topic && !note) throw new DomainError('EXPRESSION_INPUT_INVALID', 'topic 或 note 至少填写一项');
  if (input.acknowledged !== true) throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '需要确认当前用途说明', 403);
  const noticeVersion = textField(input.noticeVersion, 'noticeVersion', 80, true)!;
  return store.transaction((state) => {
    const { student, policy } = policyForRequest(state, auth, 'self_expression');
    const notice = requireNotice(state, policy!, 'self_expression', policy!.selfExpressionNoticeVersion);
    if (notice.version !== noticeVersion) throw new DomainError('EXPRESSION_NOTICE_CHANGED', '告知版本已更新，请重新阅读', 409);
    const consent = requireConsent(state, student, 'self_expression', noticeVersion);
    const body = { topic: topic as ExpressionTopic | undefined, note };
    const digest = requestDigest('expression-entry:create', student.tenantId, auth.user.id, body);
    const existing = state.expressionEntries.find((candidate) => candidate.tenantId === student.tenantId && candidate.studentId === student.id && candidate.idempotencyKey === key);
    if (existing) {
      if (existing.requestDigest !== digest.digest || existing.digestKeyVersion !== digest.version) throw new DomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求', 409);
      if (!existing.payloadCiphertext) throw new DomainError('EXPRESSION_GONE', '表达记录已删除，不能重建', 410);
      return { entry: decodeEntry(existing), created: false };
    }
    const createdAt = now();
    const expiresAt = new Date(Date.now() + policy!.entryRetentionDays * 86_400_000).toISOString();
    const record: ExpressionEntry = { id: id(), tenantId: student.tenantId, schoolId: student.schoolId, studentId: student.id, source: 'student_self_report', payloadCiphertext: encrypt(body), consentId: consent.id, noticeVersion, createdAt, expiresAt, idempotencyKey: key, requestDigest: digest.digest, digestKeyVersion: digest.version };
    state.expressionEntries.push(record);
    state.auditEvents.push({ id: id(), tenantId: student.tenantId, actorId: auth.user.id, action: 'expression.created', objectType: 'expression_entry', objectId: record.id, purpose: 'self_expression', metadata: { policyVersion: policy!.policyVersion }, createdAt });
    return { entry: decodeEntry(record), created: true };
  });
}

export async function listExpressionEntries(store: Store, auth: AuthenticatedUser): Promise<PublicExpressionEntryMeta[]> {
  return store.read((state) => {
    const student = studentFor(state, auth);
    return state.expressionEntries.filter((entry) => entry.tenantId === student.tenantId && entry.studentId === student.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((entry) => publicEntryMeta(state, entry));
  });
}

export async function getExpressionEntry(store: Store, auth: AuthenticatedUser, entryId: string): Promise<PublicExpressionEntry> {
  return store.transaction((state) => {
    const student = studentFor(state, auth);
    const entry = state.expressionEntries.find((candidate) => candidate.id === entryId && candidate.tenantId === student.tenantId && candidate.studentId === student.id);
    if (!entry) throw notFound();
    const result = decodeEntry(entry);
    state.auditEvents.push({ id: id(), tenantId: student.tenantId, actorId: auth.user.id, action: 'expression.read', objectType: 'expression_entry', objectId: entry.id, purpose: 'self_expression', metadata: {}, createdAt: now() });
    return result;
  });
}

export async function deleteExpressionEntry(store: Store, auth: AuthenticatedUser, entryId: string): Promise<void> {
  return store.transaction((state) => {
    const student = studentFor(state, auth);
    const entry = state.expressionEntries.find((candidate) => candidate.id === entryId && candidate.tenantId === student.tenantId && candidate.studentId === student.id);
    if (!entry) throw notFound();
    if (entry.deletedAt) return;
    const deletedAt = now();
    markExpressionEntryDeleted(state, entry, deletedAt);
    for (const share of state.expressionShares.filter((candidate) => candidate.tenantId === student.tenantId && candidate.entryId === entry.id)) revokeShareInternal(state, share);
    state.auditEvents.push({ id: id(), tenantId: student.tenantId, actorId: auth.user.id, action: 'expression.deleted', objectType: 'expression_entry', objectId: entry.id, purpose: 'self_expression', metadata: {}, createdAt: deletedAt });
  });
}

export async function createExpressionShare(store: Store, auth: AuthenticatedUser, input: { entryId: string; recipientId: string; ttlHours: unknown; noticeVersion: unknown; acknowledged?: unknown; idempotencyKey: unknown }): Promise<{ share: PublicExpressionShare; created: boolean }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  if (input.acknowledged !== true) throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '需要确认分享说明', 403);
  const recipientId = textField(input.recipientId, 'recipientId', 120, true)!;
  const ttlHours = Number(input.ttlHours);
  if (!Number.isInteger(ttlHours) || ![1, 24, 168].includes(ttlHours)) throw new DomainError('EXPRESSION_INPUT_INVALID', '分享期限只能是 1、24 或 168 小时');
  const noticeVersion = textField(input.noticeVersion, 'noticeVersion', 80, true)!;
  return store.transaction((state) => {
    const { student, policy } = policyForRequest(state, auth, 'self_expression');
    const notice = requireNotice(state, policy!, 'self_expression', policy!.selfExpressionNoticeVersion);
    if (notice.version !== noticeVersion) throw new DomainError('EXPRESSION_NOTICE_CHANGED', '告知版本已更新，请重新阅读', 409);
    const consent = requireConsent(state, student, 'self_expression', noticeVersion);
    const entry = state.expressionEntries.find((candidate) => candidate.id === input.entryId && candidate.tenantId === student.tenantId && candidate.studentId === student.id);
    if (!entry) throw notFound();
    if (!isEntryReadable(entry)) throw new DomainError('EXPRESSION_GONE', '表达记录已到期或删除', 410);
    if (!allowedRecipient(state, policy!, recipientId, student.schoolId, student.tenantId)) throw new DomainError('SUPPORT_RECIPIENT_UNAVAILABLE', '接收人当前不可用', 503);
    const body = { entryId: entry.id, recipientId, ttlHours };
    const digest = requestDigest('expression-share:create', student.tenantId, auth.user.id, body);
    const existingByKey = state.expressionShares.find((candidate) => candidate.tenantId === student.tenantId && candidate.studentId === student.id && candidate.idempotencyKey === key);
    if (existingByKey) {
      if (existingByKey.requestDigest !== digest.digest || existingByKey.digestKeyVersion !== digest.version) throw new DomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求', 409);
      return { share: publicShare(existingByKey, existingByKey.status === 'active' && Date.parse(existingByKey.expiresAt) <= Date.now() ? 'expired' : existingByKey.status), created: false };
    }
    const active = state.expressionShares.find((candidate) => candidate.tenantId === student.tenantId && candidate.entryId === entry.id && candidate.status === 'active' && Date.parse(candidate.expiresAt) > Date.now());
    if (active) throw new DomainError('SHARE_ACTIVE_EXISTS', '该记录已有有效分享，请先撤回', 409);
    for (const expired of state.expressionShares.filter((candidate) => candidate.tenantId === student.tenantId && candidate.entryId === entry.id && candidate.status === 'active' && Date.parse(candidate.expiresAt) <= Date.now())) expired.status = 'expired';
    const createdAt = now();
    const expiresAt = new Date(Math.min(Date.now() + ttlHours * 3_600_000, Date.parse(entry.expiresAt))).toISOString();
    const share: ExpressionShare = { id: id(), tenantId: student.tenantId, schoolId: student.schoolId, studentId: student.id, entryId: entry.id, recipientId, consentId: consent.id, noticeVersion, status: 'active', createdAt, expiresAt, idempotencyKey: key, requestDigest: digest.digest, digestKeyVersion: digest.version };
    state.expressionShares.push(share);
    state.auditEvents.push({ id: id(), tenantId: student.tenantId, actorId: auth.user.id, action: 'expression.share_created', objectType: 'expression_share', objectId: share.id, purpose: 'self_expression', metadata: { recipientId, ttlHours }, createdAt });
    return { share: publicShare(share), created: true };
  });
}

export async function listExpressionShares(store: Store, auth: AuthenticatedUser): Promise<PublicExpressionShare[]> {
  return store.transaction((state) => {
    const student = studentFor(state, auth);
    return state.expressionShares.filter((share) => share.tenantId === student.tenantId && share.studentId === student.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((share) => {
      if (share.status === 'active' && Date.parse(share.expiresAt) <= Date.now()) share.status = 'expired';
      return publicShare(share);
    });
  });
}

export async function revokeExpressionShare(store: Store, auth: AuthenticatedUser, shareId: string): Promise<void> {
  return store.transaction((state) => {
    const student = studentFor(state, auth);
    const share = state.expressionShares.find((candidate) => candidate.id === shareId && candidate.tenantId === student.tenantId && candidate.studentId === student.id);
    if (!share) throw notFound();
    if (share.status === 'active') revokeShareInternal(state, share);
    state.auditEvents.push({ id: id(), tenantId: student.tenantId, actorId: auth.user.id, action: 'expression.share_revoked', objectType: 'expression_share', objectId: share.id, purpose: 'self_expression', metadata: {}, createdAt: now() });
  });
}

export async function listProfessionalExpressionShares(store: Store, auth: AuthenticatedUser): Promise<Array<PublicExpressionShare & { studentId: string }>> {
  return store.transaction((state) => {
    const policy = policyForProfessional(state, auth);
    const output: Array<PublicExpressionShare & { studentId: string }> = [];
    for (const share of state.expressionShares) {
      if (share.tenantId !== auth.user.tenantId || share.schoolId !== auth.user.schoolId || share.recipientId !== auth.user.id) continue;
      if (share.status === 'active' && Date.parse(share.expiresAt) <= Date.now()) share.status = 'expired';
      const entry = state.expressionEntries.find((candidate) => candidate.tenantId === share.tenantId && candidate.id === share.entryId);
      const consent = currentConsent(state, share.studentId, share.tenantId, 'self_expression', share.noticeVersion);
      if (!entry || !consent || share.status !== 'active' || !isEntryReadable(entry) || !allowedRecipient(state, policy, auth.user.id, share.schoolId, share.tenantId)) continue;
      output.push({ ...publicShare(share), studentId: share.studentId });
    }
    return output;
  });
}

export async function getProfessionalExpressionShare(store: Store, auth: AuthenticatedUser, shareId: string): Promise<PublicExpressionEntry & { shareId: string; studentId: string }> {
  return store.transaction((state) => {
    const policy = policyForProfessional(state, auth);
    const share = state.expressionShares.find((candidate) => candidate.id === shareId && candidate.tenantId === auth.user.tenantId && candidate.schoolId === auth.user.schoolId && candidate.recipientId === auth.user.id);
    const entry = share && state.expressionEntries.find((candidate) => candidate.id === share.entryId && candidate.tenantId === share.tenantId && candidate.studentId === share.studentId);
    const consent = share && currentConsent(state, share.studentId, share.tenantId, 'self_expression', share.noticeVersion);
    if (!share || !entry || share.status !== 'active' || Date.parse(share.expiresAt) <= Date.now() || !isEntryReadable(entry) || !consent || !allowedRecipient(state, policy, auth.user.id, share.schoolId, share.tenantId)) throw notFound();
    const result = decodeEntry(entry);
    state.auditEvents.push({ id: id(), tenantId: share.tenantId, actorId: auth.user.id, action: 'expression.share_read', objectType: 'expression_share', objectId: share.id, purpose: 'self_expression', metadata: {}, createdAt: now() });
    return { ...result, shareId: share.id, studentId: share.studentId };
  });
}

export async function createSupportRequest(store: Store, auth: AuthenticatedUser, input: { recipientId: string; shareId?: unknown; noticeVersion: unknown; acknowledged?: unknown; idempotencyKey: unknown }): Promise<{ request: PublicSupportRequest; created: boolean }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  if (input.acknowledged !== true) throw new DomainError('EXPRESSION_CONSENT_REQUIRED', '需要确认联系说明', 403);
  const recipientId = textField(input.recipientId, 'recipientId', 120, true)!;
  const noticeVersion = textField(input.noticeVersion, 'noticeVersion', 80, true)!;
  const shareId = input.shareId === undefined || input.shareId === null || input.shareId === '' ? undefined : textField(input.shareId, 'shareId', 120);
  return store.transaction((state) => {
    const { student, policy } = policyForRequest(state, auth, 'self_expression');
    const notice = requireNotice(state, policy!, 'self_expression', policy!.selfExpressionNoticeVersion);
    if (notice.version !== noticeVersion) throw new DomainError('EXPRESSION_NOTICE_CHANGED', '告知版本已更新，请重新阅读', 409);
    const consent = requireConsent(state, student, 'self_expression', noticeVersion);
    if (!allowedRecipient(state, policy!, recipientId, student.schoolId, student.tenantId)) throw new DomainError('SUPPORT_RECIPIENT_UNAVAILABLE', '接收人当前不可用', 503);
    let share: ExpressionShare | undefined;
    if (shareId) {
      const foundShare = state.expressionShares.find((candidate) => candidate.id === shareId && candidate.tenantId === student.tenantId && candidate.studentId === student.id && candidate.recipientId === recipientId && candidate.status === 'active');
      share = foundShare;
      const entry = foundShare ? state.expressionEntries.find((candidate) => candidate.id === foundShare.entryId && candidate.tenantId === student.tenantId && candidate.studentId === student.id) : undefined;
      if (!share || !entry || !isEntryReadable(entry) || Date.parse(share.expiresAt) <= Date.now()) throw new DomainError('SHARE_UNAVAILABLE', '关联的分享已失效，请重新选择', 409);
    }
    const body = { recipientId, shareId: share?.id ?? null };
    const digest = requestDigest('support-request:create', student.tenantId, auth.user.id, body);
    const existingByKey = state.supportRequests.find((candidate) => candidate.tenantId === student.tenantId && candidate.studentId === student.id && candidate.idempotencyKey === key);
    if (existingByKey) {
      if (existingByKey.requestDigest !== digest.digest || existingByKey.digestKeyVersion !== digest.version) throw new DomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求', 409);
      return { request: publicSupportRequest(state, existingByKey), created: false };
    }
    const openForRecipient = state.supportRequests.filter((candidate) => candidate.tenantId === student.tenantId && candidate.studentId === student.id && candidate.recipientId === recipientId && NON_TERMINAL_SUPPORT.includes(candidate.state));
    if (openForRecipient.length > 0) throw new DomainError('SUPPORT_REQUEST_ACTIVE_EXISTS', '该支持人员已有未结束的请求，请先查看当前请求', 409);
    const openForStudent = state.supportRequests.filter((candidate) => candidate.tenantId === student.tenantId && candidate.studentId === student.id && NON_TERMINAL_SUPPORT.includes(candidate.state));
    if (openForStudent.length >= policy!.maxOpenRequestsPerStudent) throw new DomainError('SUPPORT_REQUEST_LIMITED', '已有过多未结束的支持请求，请先查看当前请求', 429);
    const createdAt = now();
    const request: SupportRequest = { id: id(), tenantId: student.tenantId, schoolId: student.schoolId, studentId: student.id, recipientId, ...(share ? { shareId: share.id } : {}), consentId: consent.id, noticeVersion, state: 'requested', version: 1, policyVersion: policy!.policyVersion, createdAt, updatedAt: createdAt, ackDueAt: new Date(Date.now() + policy!.ackTargetMinutes * 60_000).toISOString(), idempotencyKey: key, requestDigest: digest.digest, digestKeyVersion: digest.version };
    state.supportRequests.push(request);
    state.outboxEvents.push({ id: id(), tenantId: student.tenantId, type: 'support.request_created', aggregateId: request.id, payload: { requestId: request.id, recipientId: request.recipientId }, status: 'pending', attempts: 0, availableAt: createdAt, createdAt });
    state.auditEvents.push({ id: id(), tenantId: student.tenantId, actorId: auth.user.id, action: 'support.requested', objectType: 'support_request', objectId: request.id, purpose: 'support', metadata: { policyVersion: policy!.policyVersion }, createdAt });
    return { request: publicSupportRequest(state, request), created: true };
  });
}

function canReadSupportRequest(state: DatabaseState, auth: AuthenticatedUser, request: SupportRequest): boolean {
  if (request.tenantId !== auth.user.tenantId) return false;
  if (isStudent(auth.user)) return request.studentId === auth.user.id;
  const policy = state.expressionPolicies.find((candidate) => candidate.tenantId === request.tenantId && candidate.schoolId === request.schoolId && candidate.enabled);
  return isProfessional(auth.user) && request.recipientId === auth.user.id && auth.user.schoolId === request.schoolId && Boolean(policy && allowedRecipient(state, policy, auth.user.id, request.schoolId, request.tenantId));
}

export async function listMySupportRequests(store: Store, auth: AuthenticatedUser): Promise<PublicSupportRequest[]> {
  if (!isStudent(auth.user)) throw forbidden();
  return store.read((state) => state.supportRequests.filter((request) => request.tenantId === auth.user.tenantId && request.studentId === auth.user.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((request) => publicSupportRequest(state, request)));
}

export async function getSupportRequest(store: Store, auth: AuthenticatedUser, requestId: string): Promise<PublicSupportRequest> {
  return store.read((state) => {
    const request = state.supportRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    if (!request || !canReadSupportRequest(state, auth, request)) throw notFound();
    return publicSupportRequest(state, request);
  });
}

export async function listProfessionalSupportRequests(store: Store, auth: AuthenticatedUser): Promise<PublicSupportRequest[]> {
  policyForProfessionalStateOnly(auth);
  return store.read((state) => {
    policyForProfessional(state, auth);
    return state.supportRequests.filter((request) => request.tenantId === auth.user.tenantId && request.schoolId === auth.user.schoolId && request.recipientId === auth.user.id && (NON_TERMINAL_SUPPORT.includes(request.state) || request.state === 'completed')).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((request) => publicSupportRequest(state, request));
  });
}

function policyForProfessionalStateOnly(auth: AuthenticatedUser): void {
  if (!isProfessional(auth.user) || !auth.user.schoolId || !can(auth.user, 'support:assigned-manage')) throw forbidden();
}

export async function transitionSupportRequest(store: Store, auth: AuthenticatedUser, requestId: string, input: { action: SupportTransition; expectedVersion: number; nextFollowUpAt?: unknown }): Promise<PublicSupportRequest> {
  policyForProfessionalStateOnly(auth);
  return store.transaction((state) => {
    const request = state.supportRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    if (!request || !canReadSupportRequest(state, auth, request)) throw notFound();
    if (!Number.isInteger(input.expectedVersion) || request.version !== input.expectedVersion) throw new DomainError('SUPPORT_VERSION_CONFLICT', '支持请求已被其他窗口更新', 409, { currentVersion: request.version });
    const action = input.action;
    const allowed: Record<SupportTransition, SupportRequestState[]> = { acknowledge: ['requested'], start: ['acknowledged'], follow_up: ['acknowledged', 'in_contact', 'follow_up'], complete: ['acknowledged', 'in_contact', 'follow_up'] };
    if (!allowed[action] || !allowed[action].includes(request.state)) throw new DomainError('SUPPORT_STATE_INVALID', '支持请求状态不能执行该操作', 409);
    const timestamp = now();
    if (action === 'acknowledge') { request.state = 'acknowledged'; request.firstAcknowledgedAt ??= timestamp; cancelSupportEvent(state, request.id, 'already_acknowledged'); }
    if (action === 'start') request.state = 'in_contact';
    if (action === 'follow_up') {
      const dueAt = textField(input.nextFollowUpAt, 'nextFollowUpAt', 80, true)!;
      if (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.now()) throw new DomainError('EXPRESSION_INPUT_INVALID', '跟进时间必须是未来时间');
      request.state = 'follow_up'; request.nextFollowUpAt = new Date(dueAt).toISOString();
      state.outboxEvents.push({ id: id(), tenantId: request.tenantId, type: 'support.follow_up_due', aggregateId: request.id, payload: { requestId: request.id, recipientId: request.recipientId }, status: 'pending', attempts: 0, availableAt: request.nextFollowUpAt, createdAt: timestamp });
    }
    if (action === 'complete') { request.state = 'completed'; request.closedAt = timestamp; request.nextFollowUpAt = undefined; cancelSupportEvent(state, request.id, 'schedule_replaced'); }
    request.version += 1; request.updatedAt = timestamp;
    state.auditEvents.push({ id: id(), tenantId: request.tenantId, actorId: auth.user.id, action: `support.${action === 'follow_up' ? 'follow_up' : action === 'complete' ? 'completed' : action === 'acknowledge' ? 'acknowledged' : 'started'}`, objectType: 'support_request', objectId: request.id, purpose: 'support', metadata: { version: request.version }, createdAt: timestamp });
    return publicSupportRequest(state, request);
  });
}

export async function cancelSupportRequest(store: Store, auth: AuthenticatedUser, requestId: string, expectedVersion: number): Promise<PublicSupportRequest> {
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const request = state.supportRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId && candidate.studentId === auth.user.id);
    if (!request) throw notFound();
    if (!NON_TERMINAL_SUPPORT.includes(request.state)) return publicSupportRequest(state, request);
    if (!Number.isInteger(expectedVersion) || request.version !== expectedVersion) throw new DomainError('SUPPORT_VERSION_CONFLICT', '支持请求已被其他窗口更新', 409, { currentVersion: request.version });
    const timestamp = now(); request.state = 'cancelled'; request.cancellationReason = 'user_requested'; request.closedAt = timestamp; request.updatedAt = timestamp; request.version += 1; cancelSupportEvent(state, request.id, 'request_cancelled');
    state.auditEvents.push({ id: id(), tenantId: request.tenantId, actorId: auth.user.id, action: 'support.cancelled', objectType: 'support_request', objectId: request.id, purpose: 'support', metadata: { version: request.version }, createdAt: timestamp });
    return publicSupportRequest(state, request);
  });
}

export async function addSupportNote(store: Store, auth: AuthenticatedUser, requestId: string, input: { note: unknown; idempotencyKey: unknown }): Promise<{ id: string; createdAt: string; created: boolean }> {
  policyForProfessionalStateOnly(auth);
  const note = textField(input.note, 'note', 2000, true)!;
  const key = requireIdempotencyKey(input.idempotencyKey);
  return store.transaction((state) => {
    const request = state.supportRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    if (!request || !canReadSupportRequest(state, auth, request) || !NON_TERMINAL_SUPPORT.includes(request.state)) throw notFound();
    const digest = requestDigest('support-note:create', auth.user.tenantId, auth.user.id, { requestId, note });
    const existing = state.supportNotes.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.requestId === request.id && candidate.authorId === auth.user.id && candidate.idempotencyKey === key);
    if (existing) {
      if (existing.requestDigest !== digest.digest || existing.digestKeyVersion !== digest.version) throw new DomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求', 409);
      return { id: existing.id, createdAt: existing.createdAt, created: false };
    }
    const createdAt = now();
    const record: SupportNote = { id: id(), tenantId: request.tenantId, schoolId: request.schoolId, requestId: request.id, authorId: auth.user.id, noteCiphertext: encrypt({ note }), createdAt, idempotencyKey: key, requestDigest: digest.digest, digestKeyVersion: digest.version };
    state.supportNotes.push(record); request.version += 1; request.updatedAt = createdAt;
    state.auditEvents.push({ id: id(), tenantId: request.tenantId, actorId: auth.user.id, action: 'support.note_added', objectType: 'support_note', objectId: record.id, purpose: 'support', metadata: { requestId: request.id }, createdAt });
    return { id: record.id, createdAt, created: true };
  });
}

export async function listSupportNotes(store: Store, auth: AuthenticatedUser, requestId: string): Promise<Array<{ id: string; note: string; authorId: string; createdAt: string }>> {
  policyForProfessionalStateOnly(auth);
  return store.transaction((state) => {
    const request = state.supportRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    if (!request || !canReadSupportRequest(state, auth, request)) throw notFound();
    const notes = state.supportNotes.filter((note) => note.tenantId === request.tenantId && note.requestId === request.id).map((note) => ({ id: note.id, note: decrypt<{ note: string }>(note.noteCiphertext).note, authorId: note.authorId, createdAt: note.createdAt }));
    state.auditEvents.push({ id: id(), tenantId: request.tenantId, actorId: auth.user.id, action: 'support.note_read', objectType: 'support_request', objectId: request.id, purpose: 'support', metadata: { count: notes.length }, createdAt: now() });
    return notes;
  });
}

export async function escalateSupportRequests(store: Store, auth: AuthenticatedUser, asOf = now()): Promise<{ queued: number }> {
  if (!can(auth.user, 'system:metrics')) throw forbidden();
  if (!Number.isFinite(Date.parse(asOf))) throw new DomainError('SUPPORT_ESCALATION_INVALID', '升级扫描时间无效');
  return store.transaction((state) => {
    let queued = 0;
    for (const request of state.supportRequests.filter((candidate) => candidate.state === 'requested' && Date.parse(candidate.ackDueAt) <= Date.parse(asOf))) {
      const policy = state.expressionPolicies.find((candidate) => candidate.tenantId === request.tenantId && candidate.schoolId === request.schoolId && candidate.enabled);
      if (!policy || !policy.backupProfessionalLeadId) continue;
      const alreadyQueued = state.outboxEvents.some((event) => event.tenantId === request.tenantId && event.type === 'support.request_overdue' && event.aggregateId === request.id && ['pending', 'published'].includes(event.status));
      if (alreadyQueued) continue;
      state.outboxEvents.push({ id: id(), tenantId: request.tenantId, type: 'support.request_overdue', aggregateId: request.id, payload: { requestId: request.id, recipientId: request.recipientId, backupProfessionalLeadId: policy.backupProfessionalLeadId }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
      state.auditEvents.push({ id: id(), tenantId: request.tenantId, actorId: auth.user.id, action: 'support.escalation_queued', objectType: 'support_request', objectId: request.id, purpose: 'support', metadata: { reasonCode: 'ack_overdue' }, createdAt: now() });
      queued += 1;
    }
    return { queued };
  });
}

export async function listSupportEscalations(store: Store, auth: AuthenticatedUser): Promise<Array<{ requestId: string; recipientId: string; createdAt: string; ackDueAt: string; reasonCode: string }>> {
  if (!isProfessional(auth.user) || !can(auth.user, 'support:escalation-metadata')) throw forbidden();
  return store.read((state) => state.outboxEvents.filter((event) => event.type === 'support.request_overdue' && event.status !== 'cancelled' && event.payload.backupProfessionalLeadId === auth.user.id).map((event) => ({ requestId: String(event.payload.requestId), recipientId: String(event.payload.recipientId), createdAt: event.createdAt, ackDueAt: String(state.supportRequests.find((request) => request.id === event.aggregateId)?.ackDueAt ?? event.createdAt), reasonCode: 'ack_overdue' })));
}
