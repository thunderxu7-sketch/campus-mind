import { createHash, randomUUID } from 'node:crypto';
import { authenticate, can, isProfessional, isStudent, requirePermission, safeUser } from './auth.js';
import { contentHash, decrypt, encrypt } from './crypto.js';
import { DomainError, forbidden, notFound } from './errors.js';
import { assertUsableScale, score } from './scoring.js';
import { JsonStore } from './store.js';
import type {
  Appointment, AppointmentState, Assignment, Attempt, AuthenticatedUser, AvailabilitySlot, Campaign, CaseAcknowledgement, CaseState, ConsentRecord,
  ContentItem, DatabaseState, DeletionTombstone, ExportJob, FollowUp, ImportBatch, ImportRowResult, ProfileSchemaVersion, RightsRequest, RiskCase, RiskReview, RiskSignal, Role,
  ScaleVersion, Student, User,
} from './types.js';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const sameTenant = <T extends { tenantId: string }>(record: T, tenantId: string): boolean => record.tenantId === tenantId;
const hashExternal = (value: string): string => createHash('sha256').update(value.trim()).digest('hex');

function audit(state: DatabaseState, actor: User | undefined, action: string, objectType: string, objectId: string, metadata: Record<string, string | number | boolean | null> = {}, purpose?: string, tenantIdOverride?: string): void {
  state.auditEvents.push({ id: id(), tenantId: actor?.tenantId ?? tenantIdOverride ?? 'system', actorId: actor?.id, action, objectType, objectId, purpose, metadata, createdAt: now() });
}

function studentFor(state: DatabaseState, user: User, studentId: string): Student {
  const student = state.students.find((candidate) => candidate.id === studentId && sameTenant(candidate, user.tenantId) && candidate.active);
  if (!student) throw notFound();
  if (isStudent(user) && user.id !== studentId) throw forbidden();
  if (user.role === 'teacher' && student.schoolId !== user.schoolId) throw forbidden();
  return student;
}

function activeConsent(state: DatabaseState, studentId: string, purpose: ConsentRecord['purpose']): ConsentRecord | undefined {
  return state.consents.find((consent) => consent.studentId === studentId && consent.purpose === purpose && consent.status === 'active');
}

function ageAllowed(student: Student, scale: ScaleVersion): boolean {
  return typeof student.age === 'number' && student.age >= scale.minAge && student.age <= scale.maxAge;
}

export interface LoginResult { token: string; user: ReturnType<typeof safeUser>; expiresAt: string; }

export async function currentUser(store: JsonStore, auth: AuthenticatedUser): Promise<ReturnType<typeof safeUser>> {
  return safeUser(auth.user);
}

export async function listMyTasks(store: JsonStore, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  requirePermission(auth.user, 'self:assessment');
  return store.read((state) => {
    const assignments = state.assignments.filter((assignment) => sameTenant(assignment, auth.user.tenantId) && assignment.studentId === auth.user.id);
    return assignments.map((assignment) => {
      const campaign = state.campaigns.find((candidate) => candidate.id === assignment.campaignId && sameTenant(candidate, auth.user.tenantId));
      const scale = campaign ? state.scales.find((candidate) => candidate.id === campaign.scaleVersionId) : undefined;
      const attempt = state.attempts.find((candidate) => candidate.assignmentId === assignment.id);
      return {
        id: assignment.id,
        name: campaign?.name ?? '测评任务',
        purpose: campaign?.purpose,
        state: campaign?.state,
        opensAt: campaign?.opensAt,
        closesAt: campaign?.closesAt,
        scaleTitle: scale?.title,
        status: assignment.status,
        attempt: attempt ? { id: attempt.id, state: attempt.state, currentRevision: attempt.currentRevision } : null,
      };
    });
  });
}

export async function createConsent(store: JsonStore, auth: AuthenticatedUser, input: { studentId: string; actorType: ConsentRecord['actorType']; noticeVersion: string; purpose?: ConsentRecord['purpose'] }): Promise<ConsentRecord> {
  if (!isStudent(auth.user) && !can(auth.user, 'org:manage') && !can(auth.user, 'rights:request')) throw forbidden();
  const purpose = input.purpose ?? 'assessment';
  return store.transaction((state) => {
    const student = studentFor(state, auth.user, input.studentId);
    if (student.age !== undefined && student.age < 14 && input.actorType !== 'guardian') {
      throw new DomainError('GUARDIAN_CONSENT_REQUIRED', '不满 14 周岁需要监护人同意');
    }
    if (input.actorType === 'guardian' && !student.guardianVerified) throw new DomainError('GUARDIAN_NOT_VERIFIED', '监护关系尚未核验');
    const existing = state.consents.find((c) => c.studentId === student.id && c.purpose === purpose && c.status === 'active');
    if (existing) return existing;
    const consent: ConsentRecord = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, purpose, noticeVersion: input.noticeVersion, actorType: input.actorType, actorId: auth.user.id, status: 'active', recordedAt: now() };
    state.consents.push(consent);
    audit(state, auth.user, 'consent.recorded', 'consent', consent.id, { purpose, actorType: input.actorType });
    return consent;
  });
}

export async function withdrawConsent(store: JsonStore, auth: AuthenticatedUser, consentId: string): Promise<void> {
  return store.transaction((state) => {
    const consent = state.consents.find((candidate) => candidate.id === consentId && sameTenant(candidate, auth.user.tenantId));
    if (!consent) throw notFound();
    const student = state.students.find((candidate) => candidate.id === consent.studentId);
    if (!student || (!isStudent(auth.user) && !can(auth.user, 'org:manage')) || (isStudent(auth.user) && auth.user.id !== student.id)) throw forbidden();
    consent.status = 'withdrawn';
    consent.withdrawnAt = now();
    for (const assignment of state.assignments.filter((a) => a.studentId === student.id && a.status === 'assigned')) assignment.status = 'declined';
    audit(state, auth.user, 'consent.withdrawn', 'consent', consent.id, { purpose: consent.purpose });
    state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'consent.withdrawn', aggregateId: consent.id, payload: { studentId: student.id }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
  });
}

export async function previewImport(store: JsonStore, auth: AuthenticatedUser, input: { schoolId: string; filename: string; rows: Array<Record<string, unknown>> }): Promise<{ batch: ImportBatch; rows: ImportRowResult[] }> {
  requirePermission(auth.user, 'import:write');
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 10_000) throw new DomainError('IMPORT_INVALID', '导入行数必须在 1–10000 之间');
  return store.transaction((state) => {
    const school = state.schools.find((candidate) => candidate.id === input.schoolId && sameTenant(candidate, auth.user.tenantId));
    if (!school) throw notFound();
    const batch: ImportBatch = { id: id(), tenantId: auth.user.tenantId, schoolId: school.id, createdBy: auth.user.id, filename: input.filename.slice(0, 200), status: 'previewed', mappingVersion: 1, rowCount: input.rows.length, validRowCount: 0, errorCount: 0, createdAt: now() };
    const output: ImportRowResult[] = input.rows.map((raw, index) => {
      const externalId = typeof raw.externalId === 'string' ? raw.externalId.trim() : '';
      const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
      const age = typeof raw.age === 'number' ? raw.age : Number(raw.age);
      const classId = typeof raw.classId === 'string' ? raw.classId.trim() : '';
      const valid = Boolean(externalId && displayName && classId && Number.isInteger(age) && age >= 6 && age <= 19);
      const row: ImportRowResult = { id: id(), tenantId: auth.user.tenantId, batchId: batch.id, rowNumber: index + 1, status: valid ? 'valid' : 'error', message: valid ? undefined : '需要 externalId、displayName、classId 和 6–19 岁整数 age' };
      if (valid) batch.validRowCount += 1; else batch.errorCount += 1;
      state.importRows.push(row);
      return row;
    });
    state.importBatches.push(batch);
    audit(state, auth.user, 'import.previewed', 'import_batch', batch.id, { rowCount: batch.rowCount, validRowCount: batch.validRowCount, errorCount: batch.errorCount });
    return { batch, rows: output };
  });
}

export async function commitImport(store: JsonStore, auth: AuthenticatedUser, batchId: string, rows: Array<Record<string, unknown>>): Promise<ImportBatch> {
  requirePermission(auth.user, 'import:write');
  return store.transaction((state) => {
    const batch = state.importBatches.find((candidate) => candidate.id === batchId && sameTenant(candidate, auth.user.tenantId));
    if (!batch) throw notFound();
    if (batch.status !== 'previewed') throw new DomainError('IMPORT_ALREADY_COMMITTED', '导入批次已处理');
    if (rows.length !== batch.rowCount) throw new DomainError('IMPORT_VERSION_CONFLICT', '提交行数与预检版本不一致', 409);
    const seen = new Set<string>();
    for (const raw of rows) {
      const externalId = typeof raw.externalId === 'string' ? raw.externalId.trim() : '';
      const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
      const age = typeof raw.age === 'number' ? raw.age : Number(raw.age);
      const classId = typeof raw.classId === 'string' ? raw.classId.trim() : '';
      const refHash = hashExternal(externalId);
      if (!externalId || !displayName || !classId || !Number.isInteger(age) || age < 6 || age > 19 || seen.has(refHash)) continue;
      seen.add(refHash);
      const existing = state.students.find((student) => student.tenantId === auth.user.tenantId && student.externalRefHash === refHash);
      if (existing) continue;
      state.students.push({ id: id(), tenantId: auth.user.tenantId, schoolId: batch.schoolId, classId, externalRefHash: refHash, displayNameCiphertext: encrypt(displayName), age, guardianVerified: raw.guardianVerified === true, active: true, createdAt: now() });
    }
    batch.status = 'committed';
    for (const row of state.importRows.filter((candidate) => candidate.batchId === batch.id && candidate.status === 'valid')) row.status = 'valid';
    audit(state, auth.user, 'import.committed', 'import_batch', batch.id, { rowCount: batch.rowCount, createdStudents: seen.size });
    return batch;
  });
}

export async function createScale(store: JsonStore, auth: AuthenticatedUser, input: Omit<ScaleVersion, 'id' | 'tenantId' | 'status' | 'approvedBy' | 'approvedAt'>): Promise<ScaleVersion> {
  requirePermission(auth.user, 'scale:write');
  if (input.provenance === 'licensed' && !input.code) throw new DomainError('LICENSE_UNAVAILABLE', '授权量表需要来源登记');
  if (!input.code || !input.title || !input.version || !input.scoringVersion || !input.noticeVersion || !Number.isInteger(input.minAge) || !Number.isInteger(input.maxAge) || input.minAge < 6 || input.maxAge > 19 || input.minAge > input.maxAge) throw new DomainError('SCALE_INVALID', '量表版本或适龄范围无效');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200 || input.items.some((item) => !item || typeof item.id !== 'string' || !item.id || typeof item.prompt !== 'string' || !item.prompt || !Number.isInteger(item.min) || !Number.isInteger(item.max) || item.min > item.max || typeof item.reverse !== 'boolean' || typeof item.factor !== 'string' || !item.factor)) throw new DomainError('SCALE_INVALID', '量表题目结构无效');
  return store.transaction((state) => {
    const scale: ScaleVersion = { ...input, id: id(), tenantId: auth.user.tenantId, status: 'draft' };
    state.scales.push(scale);
    audit(state, auth.user, 'scale.created', 'scale_version', scale.id, { provenance: scale.provenance, version: scale.version });
    return scale;
  });
}

export async function approveScale(store: JsonStore, auth: AuthenticatedUser, scaleId: string): Promise<ScaleVersion> {
  requirePermission(auth.user, 'scale:approve');
  return store.transaction((state) => {
    const scale = state.scales.find((candidate) => candidate.id === scaleId && sameTenant(candidate, auth.user.tenantId));
    if (!scale) throw notFound();
    assertUsableScale({ ...scale, status: 'approved' });
    scale.status = 'approved'; scale.approvedBy = auth.user.id; scale.approvedAt = now();
    audit(state, auth.user, 'scale.approved', 'scale_version', scale.id, { version: scale.version });
    return scale;
  });
}

export async function createCampaign(store: JsonStore, auth: AuthenticatedUser, input: { schoolId: string; name: string; purpose: Campaign['purpose']; academicYear: string; opensAt: string; closesAt: string; scaleVersionId: string; participantStudentIds: string[] }): Promise<Campaign> {
  requirePermission(auth.user, 'campaign:write');
  return store.transaction((state) => {
    const school = state.schools.find((candidate) => candidate.id === input.schoolId && sameTenant(candidate, auth.user.tenantId));
    const scale = state.scales.find((candidate) => candidate.id === input.scaleVersionId && sameTenant(candidate, auth.user.tenantId));
    if (!school || !scale) throw notFound();
    if (!input.name.trim() || new Date(input.opensAt) >= new Date(input.closesAt)) throw new DomainError('CAMPAIGN_INVALID', '任务名称或时间窗无效');
    const uniqueStudents = [...new Set(input.participantStudentIds)];
    if (uniqueStudents.some((studentId) => !state.students.some((student) => student.id === studentId && student.schoolId === school.id && sameTenant(student, auth.user.tenantId)))) throw forbidden();
    const campaign: Campaign = { id: id(), tenantId: auth.user.tenantId, schoolId: school.id, name: input.name.trim(), purpose: input.purpose, state: 'draft', academicYear: input.academicYear, opensAt: input.opensAt, closesAt: input.closesAt, scaleVersionId: scale.id, reportVisibility: 'professional_review', participantStudentIds: uniqueStudents, createdBy: auth.user.id, createdAt: now() };
    state.campaigns.push(campaign); audit(state, auth.user, 'campaign.created', 'campaign', campaign.id, { participantCount: uniqueStudents.length }); return campaign;
  });
}

export async function publishCampaign(store: JsonStore, auth: AuthenticatedUser, campaignId: string): Promise<Campaign> {
  requirePermission(auth.user, 'campaign:write');
  return store.transaction((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && sameTenant(candidate, auth.user.tenantId));
    if (!campaign) throw notFound();
    const scale = state.scales.find((candidate) => candidate.id === campaign.scaleVersionId);
    if (!scale) throw notFound();
    assertUsableScale(scale);
    if (campaign.state !== 'draft' && campaign.state !== 'approved') throw new DomainError('CAMPAIGN_STATE_INVALID', '任务当前状态不能发布');
    const studentList = campaign.participantStudentIds.map((studentId) => state.students.find((student) => student.id === studentId)).filter((student): student is Student => Boolean(student));
    if (studentList.some((student) => !ageAllowed(student, scale))) throw new DomainError('AGE_REVIEW_REQUIRED', '名单中有不适龄或年龄未知的学生');
    if (studentList.some((student) => !activeConsent(state, student.id, 'assessment'))) throw new DomainError('CONSENT_REQUIRED', '名单中有学生缺少有效测评参与记录');
    const existing = new Set(state.assignments.filter((a) => a.campaignId === campaign.id).map((a) => a.studentId));
    for (const student of studentList) {
      if (existing.has(student.id)) continue;
      const frequencyKey = `${student.id}:${campaign.academicYear}`;
      const used = state.frequencyReservations.find((r) => `${r.studentId}:${r.academicYear}` === frequencyKey && r.status !== 'released');
      if (used) throw new DomainError('FREQUENCY_REVIEW_REQUIRED', `学生 ${student.id} 已有本学年测评场次`);
      const reservation = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, academicYear: campaign.academicYear, purpose: 'assessment' as const, status: 'reserved' as const, campaignId: campaign.id, createdAt: now() };
      state.frequencyReservations.push(reservation);
      state.assignments.push({ id: id(), tenantId: auth.user.tenantId, campaignId: campaign.id, studentId: student.id, frequencyReservationId: reservation.id, status: 'assigned', createdAt: now() });
    }
    campaign.state = new Date(campaign.opensAt) > new Date() ? 'scheduled' : 'open'; campaign.publishedAt = now();
    audit(state, auth.user, 'campaign.published', 'campaign', campaign.id, { assignmentCount: campaign.participantStudentIds.length });
    return campaign;
  });
}

export async function beginAttempt(store: JsonStore, auth: AuthenticatedUser, assignmentId: string): Promise<{ attempt: Attempt; scale: ScaleVersion }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const assignment = state.assignments.find((candidate) => candidate.id === assignmentId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!assignment) throw notFound();
    const campaign = state.campaigns.find((candidate) => candidate.id === assignment.campaignId);
    const student = state.students.find((candidate) => candidate.id === auth.user.id);
    const scale = campaign ? state.scales.find((candidate) => candidate.id === campaign.scaleVersionId) : undefined;
    if (!campaign || !student || !scale) throw notFound();
    if (!['open', 'scheduled'].includes(campaign.state) || new Date(campaign.opensAt) > new Date() || new Date(campaign.closesAt) <= new Date()) throw new DomainError('CAMPAIGN_CLOSED', '任务当前不在开放时间');
    assertUsableScale(scale);
    if (!activeConsent(state, student.id, 'assessment')) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    if (!ageAllowed(student, scale)) throw new DomainError('AGE_REVIEW_REQUIRED', '年龄不在该方案适用范围');
    const current = state.attempts.find((candidate) => candidate.assignmentId === assignment.id);
    if (current) return { attempt: current, scale };
    const attempt: Attempt = { id: id(), tenantId: auth.user.tenantId, assignmentId: assignment.id, studentId: student.id, scaleVersionId: scale.id, state: 'in_progress', currentRevision: 0, startedAt: now() };
    state.attempts.push(attempt); assignment.status = 'started'; audit(state, auth.user, 'attempt.started', 'attempt', attempt.id, {}, 'assessment'); return { attempt, scale };
  });
}

function answersFrom(state: DatabaseState, attempt: Attempt): Record<string, unknown> {
  const revision = state.answerRevisions.find((candidate) => candidate.attemptId === attempt.id && candidate.revision === attempt.currentRevision);
  if (!revision) throw new DomainError('ANSWERS_NOT_SAVED', '尚未保存答题内容');
  return decrypt<Record<string, unknown>>(revision.answersCiphertext);
}

export async function saveAnswers(store: JsonStore, auth: AuthenticatedUser, attemptId: string, input: { expectedRevision: number; answers: Record<string, unknown> }): Promise<{ revision: number; savedAt: string }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const attempt = state.attempts.find((candidate) => candidate.id === attemptId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!attempt || attempt.state !== 'in_progress') throw notFound();
    if (attempt.currentRevision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', '答题内容已在其他窗口更新', 409, { currentRevision: attempt.currentRevision });
    const scale = state.scales.find((candidate) => candidate.id === attempt.scaleVersionId);
    if (!scale) throw notFound();
    const allowed = new Set(scale.items.map((item) => item.id));
    if (Object.keys(input.answers).some((key) => !allowed.has(key))) throw new DomainError('ANSWER_ITEM_INVALID', '答题项不属于当前方案');
    const savedAt = now(); const revision = attempt.currentRevision + 1;
    state.answerRevisions.push({ id: id(), tenantId: auth.user.tenantId, attemptId, revision, answersCiphertext: encrypt(input.answers), savedAt, actorId: auth.user.id });
    attempt.currentRevision = revision; audit(state, auth.user, 'attempt.answers_saved', 'attempt', attempt.id, { revision }, 'assessment'); return { revision, savedAt };
  });
}

export async function submitAttempt(store: JsonStore, auth: AuthenticatedUser, attemptId: string, idempotencyKey: string): Promise<{ submissionId: string; state: Attempt['state']; scoreRunId?: string }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 120) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '需要有效的幂等键');
  return store.transaction((state) => {
    const attempt = state.attempts.find((candidate) => candidate.id === attemptId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!attempt) throw notFound();
    const existing = state.submissions.find((submission) => submission.attemptId === attempt.id);
    if (existing) {
      if (existing.idempotencyKey !== idempotencyKey) throw new DomainError('IDEMPOTENCY_CONFLICT', '该答卷已经提交', 409);
      return { submissionId: existing.id, state: attempt.state, scoreRunId: state.scoreRuns.find((run) => run.submissionId === existing.id)?.id };
    }
    const answers = answersFrom(state, attempt);
    const scale = state.scales.find((candidate) => candidate.id === attempt.scaleVersionId);
    if (!scale) throw notFound();
    const submission: import('./types.js').Submission = { id: id(), tenantId: auth.user.tenantId, attemptId: attempt.id, answerRevisionId: state.answerRevisions.find((r) => r.attemptId === attempt.id && r.revision === attempt.currentRevision)!.id, idempotencyKey, contentHash: contentHash(answers), submittedAt: now() };
    state.submissions.push(submission); attempt.state = 'scoring_pending'; attempt.submittedAt = submission.submittedAt; attempt.submissionId = submission.id;
    state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'assessment.submitted', aggregateId: attempt.id, payload: { submissionId: submission.id, scaleVersionId: scale.id }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
    audit(state, auth.user, 'attempt.submitted', 'submission', submission.id, { attemptId: attempt.id }, 'assessment'); return { submissionId: submission.id, state: attempt.state };
  });
}

export async function drainOutbox(store: JsonStore, limit = 50): Promise<{ processed: number; failed: number }> {
  let processed = 0; let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const event = await store.read((state) => state.outboxEvents.find((candidate) => candidate.status === 'pending' && new Date(candidate.availableAt) <= new Date()));
    if (!event) break;
    try {
      await processOutboxEvent(store, event.id);
      processed += 1;
    } catch {
      failed += 1;
      await store.transaction((state) => {
        const current = state.outboxEvents.find((candidate) => candidate.id === event.id);
        if (!current) return;
        current.attempts += 1; current.status = current.attempts >= 5 ? 'dead_letter' : 'pending'; current.availableAt = new Date(Date.now() + Math.min(60_000, 2 ** current.attempts * 1000)).toISOString();
      });
    }
  }
  return { processed, failed };
}

async function processOutboxEvent(store: JsonStore, eventId: string): Promise<void> {
  await store.transaction((state) => {
    const event = state.outboxEvents.find((candidate) => candidate.id === eventId && candidate.status === 'pending');
    if (!event) return;
    if (event.type === 'assessment.submitted') {
      const submission = state.submissions.find((candidate) => candidate.id === String(event.payload.submissionId));
      const attempt = submission ? state.attempts.find((candidate) => candidate.id === submission.attemptId) : undefined;
      const scale = attempt ? state.scales.find((candidate) => candidate.id === attempt.scaleVersionId) : undefined;
      if (!submission || !attempt || !scale) throw new Error('SCORING_REFERENCE_MISSING');
      const answers = answersFrom(state, attempt);
      const output = score(scale, answers);
      const run = state.scoreRuns.find((candidate) => candidate.submissionId === submission.id);
      if (run) { event.status = 'published'; return; }
      const scoreRun = { id: id(), tenantId: event.tenantId, submissionId: submission.id, scoringVersion: scale.scoringVersion, status: output.validity === 'valid' ? 'completed' as const : 'failed' as const, factorScores: output.factorScores, total: output.total, validity: output.validity, completedAt: now(), errorCode: output.invalidReason };
      state.scoreRuns.push(scoreRun); attempt.state = output.validity === 'valid' ? 'scored' : 'invalid';
      const assignment = state.assignments.find((candidate) => candidate.id === attempt.assignmentId);
      if (assignment) assignment.status = 'completed';
      const reservation = assignment ? state.frequencyReservations.find((candidate) => candidate.id === assignment.frequencyReservationId) : undefined;
      if (reservation) reservation.status = 'consumed';
      if (output.validity === 'invalid') {
        state.outboxEvents.push({ id: id(), tenantId: event.tenantId, type: 'score.failed', aggregateId: scoreRun.id, payload: { submissionId: submission.id, reason: output.invalidReason ?? 'INVALID_ANSWERS' }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
        audit(state, undefined, 'score.failed', 'score_run', scoreRun.id, { validity: output.validity }, undefined, event.tenantId);
        event.status = 'published';
        return;
      }
      const report: import('./types.js').ReportVersion = { id: id(), tenantId: event.tenantId, studentId: attempt.studentId, scoreRunId: scoreRun.id, state: 'pending_review', title: scale.title, summaryCiphertext: encrypt({ total: output.total, factorScores: output.factorScores, text: '这是演示反馈，不构成心理诊断；如有困扰请联系学校心理专业人员。' }), limitationsCiphertext: encrypt({ text: '演示方案仅用于软件流程验证，不代表有效量表、医学诊断或风险结论。' }), createdAt: now() };
      state.reports.push(report);
      if (scale.warningRule && output.validity === 'valid' && output.total >= scale.warningRule.threshold) {
        const signal: RiskSignal = { id: id(), tenantId: event.tenantId, studentId: attempt.studentId, source: 'score_rule', scoreRunId: scoreRun.id, ruleVersion: scale.scoringVersion, level: scale.warningRule.level, reasonCiphertext: encrypt({ reason: scale.warningRule.reason, total: output.total }), createdAt: now(), status: 'open' };
        state.riskSignals.push(signal);
        let riskCase = state.riskCases.find((candidate) => candidate.studentId === signal.studentId && ['pending_review', 'confirmed', 'assigned', 'in_support', 'follow_up', 'closure_requested'].includes(candidate.state));
        if (!riskCase) { riskCase = { id: id(), tenantId: event.tenantId, studentId: signal.studentId, state: 'pending_review', priority: signal.level, signalIds: [], createdAt: now(), updatedAt: now() }; state.riskCases.push(riskCase); }
        riskCase.signalIds.push(signal.id); riskCase.updatedAt = now();
        state.outboxEvents.push({ id: id(), tenantId: event.tenantId, type: 'risk.signal_created', aggregateId: riskCase.id, payload: { signalId: signal.id, level: signal.level }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
      }
      audit(state, undefined, 'score.completed', 'score_run', scoreRun.id, { validity: output.validity, reportId: report.id }, undefined, event.tenantId);
    }
    if (event.type === 'risk.signal_created') {
      const existingDelivery = state.deliveryAttempts.find((attempt) => attempt.outboxEventId === event.id && attempt.channel === 'in_app');
      if (!existingDelivery) {
        state.deliveryAttempts.push({ id: id(), tenantId: event.tenantId, outboxEventId: event.id, channel: 'in_app', status: 'sent', attemptedAt: now() });
      }
    }
    // Notification delivery is recorded separately; case acknowledgement remains a human action.
    event.status = 'published';
  });
}

export async function listReports(store: JsonStore, auth: AuthenticatedUser, studentId?: string): Promise<Array<Record<string, unknown>>> {
  if (!isProfessional(auth.user) && !isStudent(auth.user)) throw forbidden();
  return store.read((state) => {
    const reports = state.reports.filter((report) => sameTenant(report, auth.user.tenantId) && (!studentId || report.studentId === studentId));
    return reports.filter((report) => isStudent(auth.user) ? report.studentId === auth.user.id && report.state === 'released' : true).map((report) => ({ id: report.id, studentId: report.studentId, title: report.title, state: report.state, scoreRunId: report.scoreRunId, createdAt: report.createdAt, releasedAt: report.releasedAt, summary: report.state === 'released' || isProfessional(auth.user) ? decrypt(report.summaryCiphertext) : undefined }));
  });
}

export async function approveReport(store: JsonStore, auth: AuthenticatedUser, reportId: string, release = false): Promise<void> {
  requirePermission(auth.user, 'report:approve');
  return store.transaction((state) => {
    const report = state.reports.find((candidate) => candidate.id === reportId && sameTenant(candidate, auth.user.tenantId));
    if (!report || report.state === 'revoked') throw notFound();
    if (report.state !== 'pending_review' && report.state !== 'approved') throw new DomainError('REPORT_STATE_INVALID', '报告当前状态不能审核');
    report.state = release ? 'released' : 'approved'; report.approvedBy = auth.user.id; report.approvedAt = now(); if (release) report.releasedAt = now();
    audit(state, auth.user, release ? 'report.released' : 'report.approved', 'report', report.id, {});
  });
}

export async function createRiskSignal(store: JsonStore, auth: AuthenticatedUser, input: { studentId: string; level: RiskSignal['level']; reason: string; source?: RiskSignal['source'] }): Promise<RiskCase> {
  if (isStudent(auth.user)) requirePermission(auth.user, 'self:help'); else requirePermission(auth.user, 'case:review');
  return store.transaction((state) => {
    const student = studentFor(state, auth.user, input.studentId);
    const signal: RiskSignal = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, source: input.source ?? (isStudent(auth.user) ? 'self_request' : 'staff_observation'), level: input.level, reasonCiphertext: encrypt({ reason: input.reason.slice(0, 2000) }), createdAt: now(), status: 'open' };
    state.riskSignals.push(signal);
    let riskCase = state.riskCases.find((candidate) => candidate.studentId === student.id && ['pending_review', 'confirmed', 'assigned', 'in_support', 'follow_up', 'closure_requested'].includes(candidate.state));
    if (!riskCase) { riskCase = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, state: 'pending_review', priority: signal.level, signalIds: [], createdAt: now(), updatedAt: now() }; state.riskCases.push(riskCase); }
    riskCase.signalIds.push(signal.id); riskCase.priority = riskCase.priority === 'urgent' || signal.level === 'attention' ? riskCase.priority : signal.level; riskCase.updatedAt = now();
    state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'risk.signal_created', aggregateId: riskCase.id, payload: { signalId: signal.id, level: signal.level }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
    audit(state, auth.user, 'risk.signal_created', 'risk_case', riskCase.id, { level: signal.level, source: signal.source }, 'support'); return riskCase;
  });
}

export async function listCases(store: JsonStore, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!isProfessional(auth.user)) throw forbidden();
  return store.read((state) => state.riskCases.filter((candidate) => sameTenant(candidate, auth.user.tenantId)).map((riskCase) => ({ id: riskCase.id, studentId: riskCase.studentId, state: riskCase.state, priority: riskCase.priority, assignedTo: riskCase.assignedTo, signalCount: riskCase.signalIds.length, createdAt: riskCase.createdAt, updatedAt: riskCase.updatedAt })));
}

function caseFor(state: DatabaseState, auth: AuthenticatedUser, caseId: string): RiskCase {
  const riskCase = state.riskCases.find((candidate) => candidate.id === caseId && sameTenant(candidate, auth.user.tenantId));
  if (!riskCase) throw notFound();
  return riskCase;
}

export async function reviewCase(store: JsonStore, auth: AuthenticatedUser, caseId: string, input: { decision: 'dismiss' | 'confirm'; note: string }): Promise<RiskCase> {
  requirePermission(auth.user, 'case:review');
  if (!isProfessional(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (!['pending_review', 'closure_requested'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案当前状态不能复核');
    const review: RiskReview = { id: id(), tenantId: auth.user.tenantId, caseId, reviewerId: auth.user.id, decision: input.decision, noteCiphertext: encrypt({ note: input.note.slice(0, 4000) }), createdAt: now() };
    state.riskReviews.push(review);
    riskCase.state = input.decision === 'dismiss' ? 'dismissed' : 'confirmed'; riskCase.updatedAt = now();
    for (const signal of state.riskSignals.filter((candidate) => riskCase.signalIds.includes(candidate.id))) signal.status = input.decision === 'dismiss' ? 'dismissed' : 'reviewed';
    audit(state, auth.user, 'risk.case_reviewed', 'risk_case', caseId, { decision: input.decision }, 'support'); return riskCase;
  });
}

export async function assignCase(store: JsonStore, auth: AuthenticatedUser, caseId: string, assigneeId: string): Promise<RiskCase> {
  requirePermission(auth.user, 'case:assign');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    const assignee = state.users.find((candidate) => candidate.id === assigneeId && sameTenant(candidate, auth.user.tenantId) && isProfessional(candidate));
    if (!assignee) throw notFound();
    if (!['confirmed', 'assigned'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案尚未确认');
    riskCase.assignedTo = assignee.id; riskCase.state = 'assigned'; riskCase.updatedAt = now(); audit(state, auth.user, 'risk.case_assigned', 'risk_case', caseId, { assigneeId }); return riskCase;
  });
}

export async function acknowledgeCase(store: JsonStore, auth: AuthenticatedUser, caseId: string): Promise<CaseAcknowledgement> {
  requirePermission(auth.user, 'case:ack');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.assignedTo !== auth.user.id && auth.user.role !== 'professional_lead') throw forbidden();
    if (!['assigned', 'confirmed'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案当前不可接单');
    const existing = state.acknowledgements.find((ack) => ack.caseId === caseId && ack.userId === auth.user.id);
    if (existing) return existing;
    const acknowledgement: CaseAcknowledgement = { id: id(), tenantId: auth.user.tenantId, caseId, userId: auth.user.id, acknowledgedAt: now() }; state.acknowledgements.push(acknowledgement);
    riskCase.state = 'in_support'; riskCase.updatedAt = now(); audit(state, auth.user, 'risk.case_acknowledged', 'risk_case', caseId, {}); return acknowledgement;
  });
}

export async function addFollowUp(store: JsonStore, auth: AuthenticatedUser, caseId: string, input: { kind: FollowUp['kind']; note: string; dueAt?: string }): Promise<FollowUp> {
  requirePermission(auth.user, 'care:write');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.assignedTo && riskCase.assignedTo !== auth.user.id && auth.user.role !== 'professional_lead') throw forbidden();
    if (!['in_support', 'follow_up'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案尚未接单');
    const followUp: FollowUp = { id: id(), tenantId: auth.user.tenantId, caseId, authorId: auth.user.id, kind: input.kind, noteCiphertext: encrypt({ note: input.note.slice(0, 4000) }), dueAt: input.dueAt, createdAt: now() }; state.followUps.push(followUp); riskCase.state = 'follow_up'; riskCase.updatedAt = now(); audit(state, auth.user, 'care.follow_up_added', 'risk_case', caseId, { kind: input.kind }); return followUp;
  });
}

export async function requestClosure(store: JsonStore, auth: AuthenticatedUser, caseId: string, reason: string): Promise<RiskCase> {
  requirePermission(auth.user, 'care:write');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.assignedTo && riskCase.assignedTo !== auth.user.id && auth.user.role !== 'professional_lead') throw forbidden();
    if (!['follow_up', 'in_support'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案当前不能申请结案');
    riskCase.state = 'closure_requested'; riskCase.closureReasonCiphertext = encrypt({ reason: reason.slice(0, 4000) }); riskCase.updatedAt = now(); audit(state, auth.user, 'risk.closure_requested', 'risk_case', caseId, {}); return riskCase;
  });
}

export async function approveClosure(store: JsonStore, auth: AuthenticatedUser, caseId: string): Promise<RiskCase> {
  requirePermission(auth.user, 'case:review');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.state !== 'closure_requested') throw new DomainError('CASE_STATE_INVALID', '个案尚未申请结案');
    const requester = state.followUps.find((follow) => follow.caseId === caseId)?.authorId;
    if (requester === auth.user.id && auth.user.role !== 'professional_lead') throw new DomainError('SEPARATION_OF_DUTIES_REQUIRED', '结案审批需要独立专业复核');
    riskCase.state = 'closed'; riskCase.updatedAt = now(); audit(state, auth.user, 'risk.case_closed', 'risk_case', caseId, {}); return riskCase;
  });
}

export async function adminOverview(store: JsonStore, auth: AuthenticatedUser): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'analytics:read');
  return store.read((state) => {
    const tenant = auth.user.tenantId;
    const assignments = state.assignments.filter((a) => sameTenant(a, tenant));
    const reports = state.reports.filter((r) => sameTenant(r, tenant));
    const cases = state.riskCases.filter((c) => sameTenant(c, tenant) && c.state !== 'closed' && c.state !== 'dismissed');
    const suppress = (value: number, size = state.students.filter((s) => sameTenant(s, tenant)).length): number | null => size < 10 ? null : value;
    return { students: state.students.filter((s) => sameTenant(s, tenant)).length, assignments: assignments.length, completedAssignments: assignments.filter((a) => a.status === 'completed').length, releasedReports: reports.filter((r) => r.state === 'released').length, openCases: suppress(cases.length), suppressionThreshold: 10, note: '小样本指标以 null 抑制；统计不代表疾病患病率。' };
  });
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new DomainError('IMPORT_INVALID', 'CSV 至少需要表头和一行数据');
  const parse = (line: string) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
  const headers = parse(lines[0]!);
  if (headers.length === 0 || headers.some((header) => !header)) throw new DomainError('IMPORT_INVALID', 'CSV 表头无效');
  return lines.slice(1).map((line) => Object.fromEntries(parse(line).map((value, index) => [headers[index] ?? `column_${index}`, value])));
}

export async function createRightsRequest(store: JsonStore, auth: AuthenticatedUser, input: { studentId: string; kind: RightsRequest['kind']; reason?: string }): Promise<RightsRequest> {
  if (!isStudent(auth.user) && !can(auth.user, 'rights:request')) throw forbidden();
  return store.transaction((state) => {
    const student = studentFor(state, auth.user, input.studentId);
    const request: RightsRequest = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, kind: input.kind, requesterId: auth.user.id, status: 'open', reason: input.reason?.slice(0, 1000), createdAt: now() };
    state.rightsRequests.push(request);
    audit(state, auth.user, 'rights.requested', 'rights_request', request.id, { kind: request.kind });
    return request;
  });
}

export async function listRightsRequests(store: JsonStore, auth: AuthenticatedUser): Promise<RightsRequest[]> {
  requirePermission(auth.user, 'rights:read');
  return store.read((state) => state.rightsRequests.filter((request) => request.tenantId === auth.user.tenantId).map((request) => ({ ...request })));
}

export async function completeRightsRequest(store: JsonStore, auth: AuthenticatedUser, requestId: string, decision: 'complete' | 'reject'): Promise<RightsRequest> {
  requirePermission(auth.user, 'rights:manage');
  return store.transaction((state) => {
    const request = state.rightsRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    if (!request) throw notFound();
    if (!['open', 'processing'].includes(request.status)) throw new DomainError('RIGHTS_REQUEST_STATE_INVALID', '权利请求已处理');
    request.status = decision === 'complete' ? 'completed' : 'rejected'; request.completedAt = now();
    if (decision === 'complete' && request.kind === 'delete') {
      const student = state.students.find((candidate) => candidate.id === request.studentId && candidate.tenantId === auth.user.tenantId);
      if (student) {
        student.active = false;
        student.displayNameCiphertext = encrypt('已删除');
        student.externalRefHash = hashExternal(`${student.id}:deleted`);
      }
      for (const assignment of state.assignments.filter((candidate) => candidate.studentId === request.studentId)) assignment.status = 'declined';
      state.consents = state.consents.filter((consent) => consent.studentId !== request.studentId);
      state.answerRevisions = state.answerRevisions.filter((revision) => revision.attemptId && !state.attempts.some((attempt) => attempt.id === revision.attemptId && attempt.studentId === request.studentId));
      state.attempts = state.attempts.filter((attempt) => attempt.studentId !== request.studentId);
      state.submissions = state.submissions.filter((submission) => state.attempts.some((attempt) => attempt.id === submission.attemptId));
      state.scoreRuns = state.scoreRuns.filter((run) => state.submissions.some((submission) => submission.id === run.submissionId));
      state.reports = state.reports.filter((report) => report.studentId !== request.studentId);
      state.riskSignals = state.riskSignals.filter((signal) => signal.studentId !== request.studentId);
      state.riskCases = state.riskCases.filter((riskCase) => riskCase.studentId !== request.studentId);
      state.followUps = state.followUps.filter((followUp) => state.riskCases.some((riskCase) => riskCase.id === followUp.caseId));
      state.profileResponses = state.profileResponses.filter((response) => response.studentId !== request.studentId);
      state.appointments = state.appointments.filter((appointment) => appointment.studentId !== request.studentId);
      const tombstone: DeletionTombstone = { id: id(), tenantId: auth.user.tenantId, studentId: request.studentId, requestId, deletedAt: now(), retainedCategories: ['minimal_audit_event', 'deletion_tombstone'] };
      state.deletionTombstones.push(tombstone);
      state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'student.data_deleted', aggregateId: request.studentId, payload: { requestId }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
    }
    audit(state, auth.user, 'rights.completed', 'rights_request', request.id, { kind: request.kind, decision });
    return request;
  });
}

function aggregatePayload(state: DatabaseState, tenantId: string): Record<string, unknown> {
  const students = state.students.filter((student) => student.tenantId === tenantId && student.active);
  const assignments = state.assignments.filter((assignment) => assignment.tenantId === tenantId);
  const cases = state.riskCases.filter((riskCase) => riskCase.tenantId === tenantId && !['closed', 'dismissed'].includes(riskCase.state));
  const suppress = (value: number, size = students.length): number | null => size < 10 ? null : value;
  return { studentCount: students.length, assignmentCount: assignments.length, completedCount: assignments.filter((assignment) => assignment.status === 'completed').length, openCaseCount: suppress(cases.length), suppressionThreshold: 10, generatedAt: now() };
}

export async function requestExport(store: JsonStore, auth: AuthenticatedUser, input: { kind: ExportJob['kind']; studentId?: string }): Promise<ExportJob> {
  requirePermission(auth.user, 'export:request');
  if (input.kind === 'report' && !isProfessional(auth.user)) throw forbidden();
  return store.transaction((state) => {
    if (input.studentId) {
      const student = state.students.find((candidate) => candidate.id === input.studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
      if (!student) throw notFound();
    }
    const job: ExportJob = { id: id(), tenantId: auth.user.tenantId, requestedBy: auth.user.id, kind: input.kind, studentId: input.studentId, status: 'requested', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), createdAt: now() };
    state.exportJobs.push(job); audit(state, auth.user, 'export.requested', 'export_job', job.id, { kind: job.kind }); return job;
  });
}

export async function approveExport(store: JsonStore, auth: AuthenticatedUser, jobId: string): Promise<ExportJob> {
  requirePermission(auth.user, 'export:approve');
  return store.transaction((state) => {
    const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
    if (!job) throw notFound();
    if (job.status !== 'requested') throw new DomainError('EXPORT_STATE_INVALID', '导出任务当前不可审批');
    if (new Date(job.expiresAt) <= new Date()) { job.status = 'expired'; throw new DomainError('EXPORT_EXPIRED', '导出请求已过期'); }
    let payload: unknown;
    if (job.kind === 'aggregate') payload = aggregatePayload(state, auth.user.tenantId);
    else {
      if (!job.studentId) throw new DomainError('EXPORT_SCOPE_REQUIRED', '报告导出需要明确学生范围');
      const report = state.reports.find((candidate) => candidate.studentId === job.studentId && candidate.tenantId === auth.user.tenantId && candidate.state === 'released');
      if (!report) throw new DomainError('REPORT_NOT_RELEASED', '只有已发布报告可导出');
      payload = { reportId: report.id, studentId: report.studentId, title: report.title, summary: decrypt(report.summaryCiphertext), exportedAt: now(), note: '导出内容来自已发布报告，不包含原始答卷。' };
    }
    job.approvedBy = auth.user.id; job.approvedAt = now(); job.status = 'ready'; job.payloadCiphertext = encrypt(payload); audit(state, auth.user, 'export.approved', 'export_job', job.id, { kind: job.kind }); return job;
  });
}

export async function downloadExport(store: JsonStore, auth: AuthenticatedUser, jobId: string): Promise<Record<string, unknown>> {
  return store.transaction((state) => {
    const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
    if (!job || (job.requestedBy !== auth.user.id && !can(auth.user, 'export:approve'))) throw forbidden();
    if (job.status !== 'ready' || !job.payloadCiphertext) throw new DomainError('EXPORT_NOT_READY', '导出尚未准备好');
    if (new Date(job.expiresAt) <= new Date()) { job.status = 'expired'; throw new DomainError('EXPORT_EXPIRED', '导出已过期'); }
    audit(state, auth.user, 'export.downloaded', 'export_job', job.id, { kind: job.kind });
    return decrypt<Record<string, unknown>>(job.payloadCiphertext);
  });
}

export async function getAnalytics(store: JsonStore, auth: AuthenticatedUser, groupBy: string): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'analytics:read');
  const allowed = new Set(['school', 'age_band', 'academic_year']);
  if (!allowed.has(groupBy)) throw new DomainError('ANALYTICS_DIMENSION_INVALID', '该统计维度未获批准');
  return store.read((state) => {
    const tenantStudents = state.students.filter((student) => student.tenantId === auth.user.tenantId && student.active);
    const groups = new Map<string, number>();
    for (const student of tenantStudents) {
      const key = groupBy === 'school' ? student.schoolId : groupBy === 'age_band' ? (student.age === undefined ? 'unknown' : student.age < 14 ? '6-13' : '14-19') : '2026-2027';
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const rows = [...groups.entries()].map(([key, count]) => ({ key, count: count < 10 ? null : count, suppressed: count < 10 }));
    audit(state, auth.user, 'analytics.viewed', 'analytics', groupBy, { groupCount: rows.length });
    return { groupBy, rows, suppressionThreshold: 10, note: '小样本与可重识别单元已抑制；指标不是疾病患病率。' };
  });
}

export async function createProfileSchema(store: JsonStore, auth: AuthenticatedUser, input: { version: string; fields: ProfileSchemaVersion['fields'] }): Promise<ProfileSchemaVersion> {
  requirePermission(auth.user, 'profile:write');
  if (input.fields.length === 0 || input.fields.length > 50) throw new DomainError('PROFILE_SCHEMA_INVALID', '字段数量无效');
  if (input.fields.some((field) => !field.id || !field.label || !field.purpose)) throw new DomainError('PROFILE_SCHEMA_INVALID', '字段必须包含目的与标签');
  return store.transaction((state) => {
    const schema: ProfileSchemaVersion = { id: id(), tenantId: auth.user.tenantId, version: input.version, fields: input.fields, state: 'draft', createdAt: now() }; state.profileSchemas.push(schema); audit(state, auth.user, 'profile_schema.created', 'profile_schema', schema.id, { fieldCount: input.fields.length }); return schema;
  });
}

export async function approveProfileSchema(store: JsonStore, auth: AuthenticatedUser, schemaId: string): Promise<ProfileSchemaVersion> {
  requirePermission(auth.user, 'profile:approve');
  return store.transaction((state) => {
    const schema = state.profileSchemas.find((candidate) => candidate.id === schemaId && candidate.tenantId === auth.user.tenantId);
    if (!schema) throw notFound();
    schema.state = 'approved'; schema.approvedBy = auth.user.id; audit(state, auth.user, 'profile_schema.approved', 'profile_schema', schema.id, {}); return schema;
  });
}

export async function createAvailabilitySlot(store: JsonStore, auth: AuthenticatedUser, input: { counselorId: string; startsAt: string; endsAt: string; room?: string }): Promise<AvailabilitySlot> {
  requirePermission(auth.user, 'appointment:manage');
  return store.transaction((state) => {
    const counselor = state.users.find((candidate) => candidate.id === input.counselorId && candidate.tenantId === auth.user.tenantId && isProfessional(candidate));
    if (!counselor || new Date(input.startsAt) >= new Date(input.endsAt)) throw new DomainError('SLOT_INVALID', '排班人员或时间窗无效');
    const overlap = state.availabilitySlots.some((slot) => slot.tenantId === auth.user.tenantId && slot.counselorId === counselor.id && slot.status !== 'blocked' && new Date(input.startsAt) < new Date(slot.endsAt) && new Date(input.endsAt) > new Date(slot.startsAt));
    if (overlap) throw new DomainError('SLOT_CONFLICT', '咨询师时间段重叠', 409);
    const slot: AvailabilitySlot = { id: id(), tenantId: auth.user.tenantId, counselorId: counselor.id, startsAt: input.startsAt, endsAt: input.endsAt, room: input.room?.slice(0, 100), status: 'available' }; state.availabilitySlots.push(slot); audit(state, auth.user, 'availability.created', 'availability_slot', slot.id, {}); return slot;
  });
}

export async function requestAppointment(store: JsonStore, auth: AuthenticatedUser, input: { slotId: string; note?: string }): Promise<Appointment> {
  requirePermission(auth.user, 'self:appointment');
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const slot = state.availabilitySlots.find((candidate) => candidate.id === input.slotId && candidate.tenantId === auth.user.tenantId && candidate.status === 'available');
    const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
    if (!slot || !student || new Date(slot.startsAt) <= new Date()) throw new DomainError('SLOT_UNAVAILABLE', '该时段不可预约', 409);
    if (state.appointments.some((appointment) => appointment.slotId === slot.id && ['requested', 'confirmed'].includes(appointment.state))) throw new DomainError('SLOT_UNAVAILABLE', '该时段刚刚被预约', 409);
    const appointment: Appointment = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, counselorId: slot.counselorId, slotId: slot.id, state: 'requested', noteCiphertext: input.note ? encrypt({ note: input.note.slice(0, 1000) }) : undefined, createdAt: now(), updatedAt: now() }; state.appointments.push(appointment); slot.status = 'held'; audit(state, auth.user, 'appointment.requested', 'appointment', appointment.id, {}); return appointment;
  });
}

export async function updateAppointment(store: JsonStore, auth: AuthenticatedUser, appointmentId: string, stateValue: AppointmentState): Promise<Appointment> {
  if (!isStudent(auth.user) && !can(auth.user, 'appointment:manage')) throw forbidden();
  return store.transaction((state) => {
    const appointment = state.appointments.find((candidate) => candidate.id === appointmentId && candidate.tenantId === auth.user.tenantId);
    if (!appointment) throw notFound();
    if (isStudent(auth.user) && appointment.studentId !== auth.user.id) throw forbidden();
    if (isStudent(auth.user) && stateValue !== 'cancelled') throw forbidden();
    if (stateValue === 'confirmed' && !can(auth.user, 'appointment:manage')) throw forbidden();
    if (['completed', 'no_show'].includes(stateValue) && !can(auth.user, 'appointment:manage')) throw forbidden();
    appointment.state = stateValue; appointment.updatedAt = now();
    const slot = state.availabilitySlots.find((candidate) => candidate.id === appointment.slotId);
    if (slot && ['cancelled', 'completed', 'no_show'].includes(stateValue)) slot.status = 'available';
    if (slot && stateValue === 'confirmed') slot.status = 'held';
    audit(state, auth.user, `appointment.${stateValue}`, 'appointment', appointment.id, {}); return appointment;
  });
}

export async function createContent(store: JsonStore, auth: AuthenticatedUser, input: { title: string; kind: ContentItem['kind']; body: string; ageMin: number; ageMax: number; copyrightSource: string }): Promise<ContentItem> {
  requirePermission(auth.user, 'content:write');
  if (!input.title.trim() || !input.body.trim() || !input.copyrightSource.trim() || input.ageMin < 6 || input.ageMax > 19 || input.ageMin > input.ageMax) throw new DomainError('CONTENT_INVALID', '内容、版权或适龄范围无效');
  return store.transaction((state) => { const item: ContentItem = { id: id(), tenantId: auth.user.tenantId, title: input.title.trim().slice(0, 200), kind: input.kind, ageMin: input.ageMin, ageMax: input.ageMax, bodyCiphertext: encrypt({ body: input.body.slice(0, 30_000) }), state: 'draft', copyrightSource: input.copyrightSource.slice(0, 500), createdBy: auth.user.id, createdAt: now() }; state.contentItems.push(item); audit(state, auth.user, 'content.created', 'content', item.id, { kind: item.kind }); return item; });
}

export async function approveContent(store: JsonStore, auth: AuthenticatedUser, contentId: string): Promise<ContentItem> {
  requirePermission(auth.user, 'content:approve');
  return store.transaction((state) => { const item = state.contentItems.find((candidate) => candidate.id === contentId && candidate.tenantId === auth.user.tenantId); if (!item) throw notFound(); if (item.state !== 'draft' && item.state !== 'professional_review') throw new DomainError('CONTENT_STATE_INVALID', '内容当前不可审核'); item.state = 'published'; item.reviewedBy = auth.user.id; item.publishedAt = now(); audit(state, auth.user, 'content.published', 'content', item.id, {}); return item; });
}

export async function listPublicContent(store: JsonStore, age?: number): Promise<Array<Record<string, unknown>>> {
  return store.read((state) => state.contentItems.filter((item) => item.state === 'published' && (age === undefined || (age >= item.ageMin && age <= item.ageMax))).map((item) => ({ id: item.id, title: item.title, kind: item.kind, ageMin: item.ageMin, ageMax: item.ageMax, body: decrypt<{ body: string }>(item.bodyCiphertext).body, publishedAt: item.publishedAt })));
}

export async function submitProfileResponse(store: JsonStore, auth: AuthenticatedUser, input: { schemaId: string; values: Record<string, unknown> }): Promise<{ id: string; submittedAt: string }> {
  if (!isStudent(auth.user)) throw forbidden();
  requirePermission(auth.user, 'self:assessment');
  return store.transaction((state) => {
    const schema = state.profileSchemas.find((candidate) => candidate.id === input.schemaId && candidate.tenantId === auth.user.tenantId && candidate.state === 'approved');
    if (!schema) throw new DomainError('PROFILE_SCHEMA_NOT_APPROVED', '背景调查版本尚未批准');
    const allowed = new Set(schema.fields.map((field) => field.id));
    if (Object.keys(input.values).some((key) => !allowed.has(key))) throw new DomainError('PROFILE_FIELD_INVALID', '调查字段不属于当前版本');
    for (const field of schema.fields) if (field.required && (input.values[field.id] === undefined || input.values[field.id] === null || input.values[field.id] === '')) throw new DomainError('PROFILE_FIELD_REQUIRED', `缺少字段 ${field.label}`);
    const response = { id: id(), tenantId: auth.user.tenantId, studentId: auth.user.id, schemaId: schema.id, valuesCiphertext: encrypt(input.values), submittedAt: now() };
    state.profileResponses.push(response); audit(state, auth.user, 'profile_response.submitted', 'profile_response', response.id, { schemaId: schema.id }); return { id: response.id, submittedAt: response.submittedAt };
  });
}

export async function campaignProgress(store: JsonStore, auth: AuthenticatedUser, campaignId: string): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'campaign:progress');
  return store.read((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && candidate.tenantId === auth.user.tenantId);
    if (!campaign) throw notFound();
    if (auth.user.schoolId && campaign.schoolId !== auth.user.schoolId) throw forbidden();
    const assignments = state.assignments.filter((assignment) => assignment.campaignId === campaign.id && assignment.tenantId === auth.user.tenantId);
    const counts = { assigned: assignments.length, started: assignments.filter((assignment) => ['started', 'completed'].includes(assignment.status)).length, completed: assignments.filter((assignment) => assignment.status === 'completed').length, declined: assignments.filter((assignment) => assignment.status === 'declined').length };
    audit(state, auth.user, 'campaign.progress_viewed', 'campaign', campaign.id, counts);
    return { campaignId: campaign.id, state: campaign.state, ...counts, note: '仅显示任务进度，不包含分数、答案或风险等级。' };
  });
}

export async function createSelfScreening(store: JsonStore, auth: AuthenticatedUser, scaleId: string, academicYear = '2026-2027'): Promise<{ campaign: Campaign; assignment: Assignment }> {
  if (!isStudent(auth.user)) throw forbidden();
  requirePermission(auth.user, 'self:assessment');
  return store.transaction((state) => {
    const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
    const scale = state.scales.find((candidate) => candidate.id === scaleId && candidate.tenantId === auth.user.tenantId);
    if (!student || !scale) throw notFound();
    assertUsableScale(scale);
    if (!activeConsent(state, student.id, 'assessment')) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    if (!ageAllowed(student, scale)) throw new DomainError('AGE_REVIEW_REQUIRED', '年龄不在该方案适用范围');
    if (state.frequencyReservations.some((reservation) => reservation.tenantId === auth.user.tenantId && reservation.studentId === student.id && reservation.academicYear === academicYear && reservation.status !== 'released')) throw new DomainError('FREQUENCY_REVIEW_REQUIRED', '本学年已有测评场次');
    const campaign: Campaign = { id: id(), tenantId: auth.user.tenantId, schoolId: student.schoolId, name: '学生自选支持筛查（需专业复核）', purpose: 'screening', state: 'open', academicYear, opensAt: now(), closesAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), scaleVersionId: scale.id, reportVisibility: 'professional_review', participantStudentIds: [student.id], createdBy: auth.user.id, publishedAt: now(), createdAt: now() };
    const reservation = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, academicYear, purpose: 'assessment' as const, status: 'reserved' as const, campaignId: campaign.id, createdAt: now() };
    const assignment: Assignment = { id: id(), tenantId: auth.user.tenantId, campaignId: campaign.id, studentId: student.id, frequencyReservationId: reservation.id, status: 'assigned', createdAt: now() };
    state.campaigns.push(campaign); state.frequencyReservations.push(reservation); state.assignments.push(assignment); audit(state, auth.user, 'self_screening.created', 'campaign', campaign.id, { scaleVersionId: scale.id }); return { campaign, assignment };
  });
}

export async function regionalAnalytics(store: JsonStore, auth: AuthenticatedUser): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'analytics:regional');
  return store.read((state) => {
    const regions = new Map<string, { tenants: number; students: number; openCases: number }>();
    for (const tenant of state.tenants) {
      const region = tenant.region ?? 'unassigned';
      const entry = regions.get(region) ?? { tenants: 0, students: 0, openCases: 0 };
      entry.tenants += 1; entry.students += state.students.filter((student) => student.tenantId === tenant.id && student.active).length; entry.openCases += state.riskCases.filter((riskCase) => riskCase.tenantId === tenant.id && !['closed', 'dismissed'].includes(riskCase.state)).length; regions.set(region, entry);
    }
    const rows = [...regions.entries()].map(([region, value]) => ({ region, tenants: value.tenants, students: value.students < 10 ? null : value.students, openCases: value.students < 10 ? null : value.openCases, suppressed: value.students < 10 }));
    audit(state, auth.user, 'analytics.regional_viewed', 'regional_analytics', 'all', { regionCount: rows.length }); return { rows, suppressionThreshold: 10, note: '仅提供批准的区域聚合；小样本与个体风险均不展示。' };
  });
}


export async function listStudents(store: JsonStore, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!can(auth.user, 'org:read')) throw forbidden();
  if (auth.user.role === 'teacher') throw forbidden();
  return store.read((state) => state.students.filter((student) => student.tenantId === auth.user.tenantId && student.active && (!auth.user.schoolId || student.schoolId === auth.user.schoolId)).map((student) => ({ id: student.id, schoolId: student.schoolId, classId: student.classId, age: student.age, guardianVerified: student.guardianVerified })));
}

export async function listCampaigns(store: JsonStore, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!can(auth.user, 'campaign:read')) throw forbidden();
  return store.read((state) => state.campaigns.filter((campaign) => campaign.tenantId === auth.user.tenantId && (!auth.user.schoolId || campaign.schoolId === auth.user.schoolId)).map((campaign) => ({ id: campaign.id, name: campaign.name, purpose: campaign.purpose, state: campaign.state, academicYear: campaign.academicYear, opensAt: campaign.opensAt, closesAt: campaign.closesAt, participantCount: campaign.participantStudentIds.length })));
}

export async function listScaleCatalog(store: JsonStore, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!isProfessional(auth.user) && !can(auth.user, 'campaign:read')) throw forbidden();
  return store.read((state) => state.scales.filter((scale) => scale.tenantId === auth.user.tenantId).map((scale) => ({ id: scale.id, code: scale.code, title: scale.title, version: scale.version, provenance: scale.provenance, status: scale.status, minAge: scale.minAge, maxAge: scale.maxAge, scoringVersion: scale.scoringVersion })));
}

export async function updateCampaignState(store: JsonStore, auth: AuthenticatedUser, campaignId: string, nextState: Campaign['state']): Promise<Campaign> {
  requirePermission(auth.user, 'campaign:write');
  return store.transaction((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && candidate.tenantId === auth.user.tenantId);
    if (!campaign) throw notFound();
    const allowed: Record<Campaign['state'], Campaign['state'][]> = {
      draft: ['approved', 'cancelled'], approved: ['scheduled', 'open', 'cancelled'], scheduled: ['open', 'paused', 'cancelled'], open: ['paused', 'closed'], paused: ['open', 'closed', 'cancelled'], closed: ['archived'], cancelled: ['archived'], archived: [],
    };
    if (!allowed[campaign.state].includes(nextState)) throw new DomainError('CAMPAIGN_STATE_INVALID', '任务状态不能这样变更');
    campaign.state = nextState;
    if (['closed', 'cancelled', 'archived'].includes(nextState)) {
      for (const assignment of state.assignments.filter((candidate) => candidate.campaignId === campaign.id && candidate.status === 'assigned')) assignment.status = 'expired';
      if (nextState !== 'closed') for (const reservation of state.frequencyReservations.filter((candidate) => candidate.campaignId === campaign.id && candidate.status === 'reserved')) reservation.status = 'released';
    }
    audit(state, auth.user, `campaign.${nextState}`, 'campaign', campaign.id, {}); return campaign;
  });
}

export async function revokeReport(store: JsonStore, auth: AuthenticatedUser, reportId: string, reason: string): Promise<void> {
  requirePermission(auth.user, 'report:approve');
  return store.transaction((state) => {
    const report = state.reports.find((candidate) => candidate.id === reportId && candidate.tenantId === auth.user.tenantId);
    if (!report || !['approved', 'released'].includes(report.state)) throw notFound();
    report.state = 'revoked'; report.revokedAt = now(); audit(state, auth.user, 'report.revoked', 'report', report.id, { reason: reason.slice(0, 200) });
  });
}
