import { createHash, randomUUID } from 'node:crypto';
import { authenticate, can, isProfessional, isStudent, requirePermission, safeUser } from './auth.js';
import { contentHash, decrypt, encrypt } from './crypto.js';
import { DomainError, forbidden, notFound } from './errors.js';
import { assertUsableScale, score } from './scoring.js';
import { JsonStore } from './store.js';
import type {
  Assignment, Attempt, AuthenticatedUser, Campaign, CaseAcknowledgement, CaseState, ConsentRecord,
  DatabaseState, FollowUp, ImportBatch, ImportRowResult, RiskCase, RiskReview, RiskSignal, Role,
  ScaleVersion, Student, User,
} from './types.js';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const sameTenant = <T extends { tenantId: string }>(record: T, tenantId: string): boolean => record.tenantId === tenantId;
const hashExternal = (value: string): string => createHash('sha256').update(value.trim()).digest('hex');

function audit(state: DatabaseState, actor: User | undefined, action: string, objectType: string, objectId: string, metadata: Record<string, string | number | boolean | null> = {}, purpose?: string): void {
  state.auditEvents.push({ id: id(), tenantId: actor?.tenantId ?? 'system', actorId: actor?.id, action, objectType, objectId, purpose, metadata, createdAt: now() });
}

function studentFor(state: DatabaseState, user: User, studentId: string): Student {
  const student = state.students.find((candidate) => candidate.id === studentId && sameTenant(candidate, user.tenantId) && candidate.active);
  if (!student) throw notFound();
  if (isStudent(user) && user.id !== studentId) throw forbidden();
  if (user.role === 'teacher' && student.classId !== user.schoolId) throw forbidden();
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
      const scoreRun = { id: id(), tenantId: event.tenantId, submissionId: submission.id, scoringVersion: scale.scoringVersion, status: 'completed' as const, factorScores: output.factorScores, total: output.total, validity: output.validity, completedAt: now(), errorCode: output.invalidReason };
      state.scoreRuns.push(scoreRun); attempt.state = output.validity === 'valid' ? 'scored' : 'invalid';
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
      audit(state, undefined, 'score.completed', 'score_run', scoreRun.id, { validity: output.validity, reportId: report.id });
    }
    // Notification events are acknowledged as delivered only; case acknowledgement remains a human action.
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
