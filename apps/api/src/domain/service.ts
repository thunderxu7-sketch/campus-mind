import { createHash, randomUUID } from 'node:crypto';
import { authenticate, can, isProfessional, isStudent, requirePermission, safeUser } from './auth.js';
import { contentHash, decrypt, encrypt } from './crypto.js';
import { DomainError, forbidden, notFound } from './errors.js';
import { assertUsableScale, score } from './scoring.js';
import type { Store } from './store.js';
import type {
  Appointment, AppointmentState, Assignment, Attempt, AuthenticatedUser, AvailabilitySlot, Campaign, CaseAcknowledgement, CaseState, ConsentRecord,
  ContentItem, DatabaseState, DeletionTombstone, ExportJob, FollowUp, FrequencyReservation, GuardianLink, ImportBatch, ImportRowResult, MediaAsset, MediaKind, ProfileSchemaVersion, RightsRequest, RiskCase, RiskReview, RiskSignal,
  ScaleVersion, Student, User,
} from './types.js';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const sameTenant = <T extends { tenantId: string }>(record: T, tenantId: string): boolean => record.tenantId === tenantId;
const hashExternal = (value: string): string => createHash('sha256').update(value.trim()).digest('hex');
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(new Date(value).getTime());
const academicYearPattern = /^(\d{4})-(\d{4})$/;
function currentAcademicYear(date = new Date()): string {
  const configured = process.env.CAMPMIND_ACADEMIC_YEAR?.trim();
  const configuredMatch = configured?.match(academicYearPattern);
  if (configuredMatch && Number(configuredMatch[2]) === Number(configuredMatch[1]) + 1) return configured!;
  // Chinese school years normally begin in September.  Keep the fallback
  // server-derived so a student cannot pick an arbitrary year to bypass the
  // annual frequency reservation.
  const startYear = date.getUTCMonth() >= 8 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${startYear}-${startYear + 1}`;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const importPreviewHash = (rows: Array<Record<string, unknown>>): string => createHash('sha256').update(stableJson(rows)).digest('hex');
type PublicRightsRequest = Omit<RightsRequest, 'resultCiphertext' | 'decisionReasonCiphertext' | 'reason' | 'reasonCiphertext'> & { resultReady: boolean; hasReason: boolean };
type PublicExportJob = Omit<ExportJob, 'payloadCiphertext'> & { ready: boolean };
type PublicConsent = Pick<ConsentRecord, 'id' | 'purpose' | 'noticeVersion' | 'actorType' | 'status' | 'recordedAt' | 'withdrawnAt'>;
type PublicFrequencyReservation = Omit<FrequencyReservation, 'reason' | 'reasonCiphertext'> & { hasReason: boolean };
type PublicSelfScreening = {
  campaign: Pick<Campaign, 'id' | 'name' | 'purpose' | 'state' | 'academicYear' | 'opensAt' | 'closesAt' | 'reportVisibility'>;
  assignment: Pick<Assignment, 'id' | 'campaignId' | 'status' | 'createdAt'>;
};
type PublicRiskCase = Pick<RiskCase, 'id' | 'studentId' | 'state' | 'priority' | 'assignedTo' | 'createdAt' | 'updatedAt'> & { signalCount: number };
type PublicFollowUp = Pick<FollowUp, 'id' | 'caseId' | 'kind' | 'dueAt' | 'createdAt'> & { hasNote: boolean };
type PublicCaseAcknowledgement = Pick<CaseAcknowledgement, 'id' | 'caseId' | 'acknowledgedAt'>;

function publicConsent(consent: ConsentRecord): PublicConsent {
  return { id: consent.id, purpose: consent.purpose, noticeVersion: consent.noticeVersion, actorType: consent.actorType, status: consent.status, recordedAt: consent.recordedAt, withdrawnAt: consent.withdrawnAt };
}

function publicFrequencyReservation(reservation: FrequencyReservation): PublicFrequencyReservation {
  const { reason: _reason, reasonCiphertext: _reasonCiphertext, ...publicReservation } = reservation;
  return { ...publicReservation, hasReason: Boolean(_reason || _reasonCiphertext) };
}

function publicRiskCase(riskCase: RiskCase): PublicRiskCase {
  return { id: riskCase.id, studentId: riskCase.studentId, state: riskCase.state, priority: riskCase.priority, assignedTo: riskCase.assignedTo, signalCount: riskCase.signalIds.length, createdAt: riskCase.createdAt, updatedAt: riskCase.updatedAt };
}

function publicFollowUp(followUp: FollowUp): PublicFollowUp {
  return { id: followUp.id, caseId: followUp.caseId, kind: followUp.kind, dueAt: followUp.dueAt, createdAt: followUp.createdAt, hasNote: Boolean(followUp.noteCiphertext) };
}

function publicCaseAcknowledgement(acknowledgement: CaseAcknowledgement): PublicCaseAcknowledgement {
  return { id: acknowledgement.id, caseId: acknowledgement.caseId, acknowledgedAt: acknowledgement.acknowledgedAt };
}

function publicRightsRequest(request: RightsRequest): PublicRightsRequest {
  const { resultCiphertext: _resultCiphertext, decisionReasonCiphertext: _decisionReasonCiphertext, reason: _reason, reasonCiphertext: _reasonCiphertext, ...publicRequest } = request;
  return { ...publicRequest, resultReady: Boolean(_resultCiphertext), hasReason: Boolean(_reason || _reasonCiphertext) };
}

function audit(state: DatabaseState, actor: User | undefined, action: string, objectType: string, objectId: string, metadata: Record<string, string | number | boolean | null> = {}, purpose?: string, tenantIdOverride?: string): void {
  const safeMetadata = Object.fromEntries(Object.entries(metadata).map(([key, value]) => {
    // Free-text reasons/notes and credential-like fields do not belong in an
    // audit envelope. Keep a bounded marker so the event remains useful
    // without copying sensitive content into logs or APM indexes.
    if (/password|token|secret|credential|code|note|reason|email|phone|name|body|answer/i.test(key)) return [key, typeof value === 'string' ? '[redacted]' : value];
    if (typeof value === 'string') return [key, value.slice(0, 200)];
    return [key, value];
  })) as Record<string, string | number | boolean | null>;
  state.auditEvents.push({ id: id(), tenantId: actor?.tenantId ?? tenantIdOverride ?? 'system', actorId: actor?.id, action, objectType, objectId, purpose, metadata: safeMetadata, createdAt: now() });
}

function studentFor(state: DatabaseState, user: User, studentId: string): Student {
  const student = state.students.find((candidate) => candidate.id === studentId && sameTenant(candidate, user.tenantId) && candidate.active);
  if (!student) throw notFound();
  if (isStudent(user) && user.id !== studentId) throw forbidden();
  if (user.schoolId && student.schoolId !== user.schoolId) throw forbidden();
  return student;
}

function activeConsent(state: DatabaseState, studentId: string, purpose: ConsentRecord['purpose'], tenantId?: string): ConsentRecord | undefined {
  return state.consents.find((consent) => consent.studentId === studentId && (!tenantId || consent.tenantId === tenantId) && consent.purpose === purpose && consent.status === 'active');
}

function revokeStudentAssessmentProcessing(state: DatabaseState, tenantId: string, studentId: string): void {
  const attempts = state.attempts.filter((attempt) => attempt.tenantId === tenantId && attempt.studentId === studentId && ['in_progress', 'scoring_pending'].includes(attempt.state));
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const submissionIds = new Set(state.submissions.filter((submission) => submission.tenantId === tenantId && attemptIds.has(submission.attemptId)).map((submission) => submission.id));
  for (const assignment of state.assignments.filter((assignment) => assignment.tenantId === tenantId && assignment.studentId === studentId && ['assigned', 'started'].includes(assignment.status))) assignment.status = 'declined';
  for (const reservation of state.frequencyReservations.filter((reservation) => reservation.tenantId === tenantId && reservation.studentId === studentId && ['reserved', 'exception'].includes(reservation.status))) reservation.status = 'released';
  for (const attempt of attempts) attempt.state = 'withdrawn';
  state.outboxEvents = state.outboxEvents.filter((event) => !(event.tenantId === tenantId && (event.type === 'assessment.submitted' || event.type === 'risk.triage') && submissionIds.has(String(event.payload.submissionId))));
  for (const job of state.exportJobs.filter((job) => job.tenantId === tenantId && job.studentId === studentId && ['requested', 'approved', 'ready'].includes(job.status))) { job.status = 'revoked'; job.payloadCiphertext = undefined; }
}

interface PurgeResult { deletedAttemptIds: Set<string>; deletedSubmissionIds: Set<string>; deletedCaseIds: Set<string>; }

/**
 * Remove sensitive student derivatives while retaining only the minimum rights
 * request/tombstone/audit trail needed to prove the deletion.  The helper is
 * intentionally idempotent so a restored backup can replay the same tombstone.
 */
function purgeStudentData(state: DatabaseState, tenantId: string, studentId: string): PurgeResult {
  const deletedAttemptIds = new Set(state.attempts.filter((attempt) => attempt.tenantId === tenantId && attempt.studentId === studentId).map((attempt) => attempt.id));
  const deletedSubmissionIds = new Set(state.submissions.filter((submission) => submission.tenantId === tenantId && deletedAttemptIds.has(submission.attemptId)).map((submission) => submission.id));
  const deletedCaseIds = new Set(state.riskCases.filter((riskCase) => riskCase.tenantId === tenantId && riskCase.studentId === studentId).map((riskCase) => riskCase.id));
  const student = state.students.find((candidate) => candidate.tenantId === tenantId && candidate.id === studentId);
  if (student) {
    student.active = false;
    student.displayNameCiphertext = encrypt('已删除');
    student.externalRefHash = hashExternal(`${student.id}:deleted`);
    student.classId = 'deleted';
    student.age = undefined;
    student.guardianVerified = false;
  }
  const deletedUser = state.users.find((user) => user.tenantId === tenantId && user.id === studentId && user.role === 'student');
  if (deletedUser) { deletedUser.active = false; deletedUser.displayName = '已删除'; deletedUser.email = `deleted+${deletedUser.id}@invalid.local`; deletedUser.schoolId = undefined; }
  state.sessions = state.sessions.filter((session) => !(session.tenantId === tenantId && session.userId === studentId));
  state.studentAccessCredentials = state.studentAccessCredentials.filter((credential) => !(credential.tenantId === tenantId && credential.studentId === studentId));
  state.guardianLinks = state.guardianLinks.filter((link) => !(link.tenantId === tenantId && link.studentId === studentId));
  state.assignments = state.assignments.filter((assignment) => !(assignment.tenantId === tenantId && assignment.studentId === studentId));
  state.frequencyReservations = state.frequencyReservations.filter((reservation) => !(reservation.tenantId === tenantId && reservation.studentId === studentId));
  for (const campaign of state.campaigns.filter((campaign) => campaign.tenantId === tenantId)) campaign.participantStudentIds = campaign.participantStudentIds.filter((candidate) => candidate !== studentId);
  state.consents = state.consents.filter((consent) => !(consent.tenantId === tenantId && consent.studentId === studentId));
  state.answerRevisions = state.answerRevisions.filter((revision) => !(revision.tenantId === tenantId && deletedAttemptIds.has(revision.attemptId)));
  state.attempts = state.attempts.filter((attempt) => !(attempt.tenantId === tenantId && deletedAttemptIds.has(attempt.id)));
  state.submissions = state.submissions.filter((submission) => !(submission.tenantId === tenantId && deletedSubmissionIds.has(submission.id)));
  state.scoreRuns = state.scoreRuns.filter((run) => !(run.tenantId === tenantId && deletedSubmissionIds.has(run.submissionId)));
  state.reports = state.reports.filter((report) => !(report.tenantId === tenantId && report.studentId === studentId));
  state.riskSignals = state.riskSignals.filter((signal) => !(signal.tenantId === tenantId && signal.studentId === studentId));
  state.riskCases = state.riskCases.filter((riskCase) => !(riskCase.tenantId === tenantId && riskCase.studentId === studentId));
  // Reviews and acknowledgements are sensitive derivatives of the deleted
  // case.  Keep only the tombstone/audit evidence, never orphaned notes or
  // staff activity that could re-identify the student.
  state.riskReviews = state.riskReviews.filter((review) => !(review.tenantId === tenantId && deletedCaseIds.has(review.caseId)));
  state.acknowledgements = state.acknowledgements.filter((ack) => !(ack.tenantId === tenantId && deletedCaseIds.has(ack.caseId)));
  state.followUps = state.followUps.filter((followUp) => !(followUp.tenantId === tenantId && deletedCaseIds.has(followUp.caseId)));
  state.profileResponses = state.profileResponses.filter((response) => !(response.tenantId === tenantId && response.studentId === studentId));
  state.appointments = state.appointments.filter((appointment) => !(appointment.tenantId === tenantId && appointment.studentId === studentId));
  for (const rights of state.rightsRequests.filter((rights) => rights.tenantId === tenantId && rights.studentId === studentId)) { rights.resultCiphertext = undefined; rights.reasonCiphertext = undefined; rights.reason = undefined; }
  for (const job of state.exportJobs.filter((job) => job.tenantId === tenantId && job.studentId === studentId)) { job.status = 'revoked'; job.payloadCiphertext = undefined; }
  state.outboxEvents = state.outboxEvents.filter((event) => event.tenantId !== tenantId || (!(event.type === 'assessment.submitted' && deletedSubmissionIds.has(String(event.payload.submissionId))) && !(event.type === 'risk.triage' && deletedSubmissionIds.has(String(event.payload.submissionId))) && !(['risk.signal_created', 'risk.escalation'].includes(event.type) && deletedCaseIds.has(event.aggregateId))));
  state.deliveryAttempts = state.deliveryAttempts.filter((delivery) => state.outboxEvents.some((event) => event.tenantId === delivery.tenantId && event.id === delivery.outboxEventId));
  return { deletedAttemptIds, deletedSubmissionIds, deletedCaseIds };
}

function ageAllowed(student: Student, scale: ScaleVersion): boolean {
  return typeof student.age === 'number' && student.age >= scale.minAge && student.age <= scale.maxAge;
}

function professionalCanReadStudent(state: DatabaseState, auth: AuthenticatedUser, studentId: string): boolean {
  if (!isProfessional(auth.user)) return false;
  const student = state.students.find((candidate) => candidate.id === studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
  if (!student || (auth.user.schoolId && auth.user.schoolId !== student.schoolId)) return false;
  if (auth.user.role === 'professional_lead') return true;
  return state.riskCases.some((riskCase) => riskCase.tenantId === auth.user.tenantId && riskCase.studentId === student.id && riskCase.assignedTo === auth.user.id && ['assigned', 'in_support', 'follow_up', 'closure_requested'].includes(riskCase.state));
}

export interface LoginResult { token: string; user: ReturnType<typeof safeUser>; expiresAt: string; }

export async function currentUser(store: Store, auth: AuthenticatedUser): Promise<ReturnType<typeof safeUser>> {
  return safeUser(auth.user);
}

export async function listMyTasks(store: Store, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  requirePermission(auth.user, 'self:assessment');
  return store.read((state) => {
    const currentTime = new Date();
    const assignments = state.assignments.filter((assignment) => sameTenant(assignment, auth.user.tenantId) && assignment.studentId === auth.user.id);
    return assignments.map((assignment) => {
      const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
      const campaign = state.campaigns.find((candidate) => candidate.id === assignment.campaignId && sameTenant(candidate, auth.user.tenantId));
      const scale = campaign ? state.scales.find((candidate) => candidate.id === campaign.scaleVersionId && sameTenant(candidate, auth.user.tenantId)) : undefined;
      const attempt = state.attempts.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.assignmentId === assignment.id);
      const reservation = assignment.frequencyReservationId ? state.frequencyReservations.find((candidate) => candidate.id === assignment.frequencyReservationId && candidate.tenantId === auth.user.tenantId) : undefined;
      const terminal = ['completed', 'declined', 'expired'].includes(assignment.status) || Boolean(attempt && ['submitted', 'scoring_pending', 'scored', 'scoring_failed', 'invalid', 'withdrawn', 'expired'].includes(attempt.state));
      const inWindow = Boolean(campaign && ['open', 'scheduled'].includes(campaign.state) && validDate(campaign.opensAt) && validDate(campaign.closesAt) && new Date(campaign.opensAt) <= currentTime && new Date(campaign.closesAt) > currentTime);
      // Keep the task list server-authoritative: a revoked/expired/licence-
      // invalid scale must not be shown as startable just because its campaign
      // and frequency reservation still look open.  Use the same guard as the
      // begin/save/submit paths, but map the failure to a stable UI reason.
      const scaleUsable = (() => {
        if (!scale) return false;
        try { assertUsableScale(scale, currentTime); return true; } catch { return false; }
      })();
      const consented = Boolean(student && activeConsent(state, student.id, 'assessment', auth.user.tenantId));
      const ageEligible = Boolean(scaleUsable && student && scale && ageAllowed(student, scale));
      const available = !terminal && ['assigned', 'started'].includes(assignment.status) && inWindow && scaleUsable && ageEligible && consented && Boolean(reservation && ['reserved', 'exception'].includes(reservation.status));
      const availabilityReason = terminal ? 'terminal' : !['assigned', 'started'].includes(assignment.status) ? 'assignment_unavailable' : !inWindow ? 'outside_window' : !scaleUsable ? 'scale_unavailable' : !consented ? 'consent_required' : !ageEligible ? 'age_not_allowed' : !reservation || !['reserved', 'exception'].includes(reservation.status) ? 'frequency_review' : 'available';
      return {
        id: assignment.id,
        name: campaign?.name ?? '测评任务',
        purpose: campaign?.purpose,
        state: campaign?.state,
        opensAt: campaign?.opensAt,
        closesAt: campaign?.closesAt,
        scaleTitle: scale?.title,
        noticeVersion: scale?.noticeVersion,
        status: assignment.status,
        available,
        availabilityReason,
        attempt: attempt ? { id: attempt.id, state: attempt.state, currentRevision: attempt.currentRevision } : null,
      };
    });
  });
}

export async function createGuardianLink(store: Store, auth: AuthenticatedUser, studentId: string, guardianUserId: string): Promise<GuardianLink> {
  requirePermission(auth.user, 'org:manage');
  return store.transaction((state) => {
    const student = state.students.find((candidate) => candidate.id === studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
    const guardian = state.users.find((candidate) => candidate.id === guardianUserId && candidate.tenantId === auth.user.tenantId && candidate.role === 'guardian' && candidate.active);
    if (!student || !guardian || guardian.schoolId !== student.schoolId || (auth.user.schoolId && auth.user.schoolId !== student.schoolId)) throw notFound();
    const existing = state.guardianLinks.find((link) => link.tenantId === auth.user.tenantId && link.studentId === student.id && link.guardianUserId === guardian.id && link.status !== 'revoked');
    if (existing) return existing;
    const link: GuardianLink = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, guardianUserId: guardian.id, status: 'pending', createdAt: now() };
    state.guardianLinks.push(link);
    audit(state, auth.user, 'guardian_link.created', 'guardian_link', link.id, { studentId, guardianUserId });
    return link;
  });
}

export async function verifyGuardianLink(store: Store, auth: AuthenticatedUser, linkId: string): Promise<GuardianLink> {
  requirePermission(auth.user, 'org:manage');
  return store.transaction((state) => {
    const link = state.guardianLinks.find((candidate) => candidate.id === linkId && candidate.tenantId === auth.user.tenantId);
    if (!link) throw notFound();
    const linkedStudent = state.students.find((candidate) => candidate.id === link.studentId && candidate.tenantId === auth.user.tenantId);
    if (!linkedStudent || (auth.user.schoolId && linkedStudent.schoolId !== auth.user.schoolId)) throw notFound();
    if (link.status === 'revoked') throw new DomainError('GUARDIAN_LINK_REVOKED', '监护关系已撤销');
    link.status = 'verified'; link.verifiedBy = auth.user.id; link.verifiedAt = now();
    linkedStudent.guardianVerified = true;
    audit(state, auth.user, 'guardian_link.verified', 'guardian_link', link.id, { studentId: link.studentId, guardianUserId: link.guardianUserId });
    return link;
  });
}

export async function createConsent(store: Store, auth: AuthenticatedUser, input: { studentId: string; actorType: ConsentRecord['actorType']; noticeVersion: string; purpose?: ConsentRecord['purpose'] }): Promise<PublicConsent> {
  if (!isStudent(auth.user) && !can(auth.user, 'org:manage') && !can(auth.user, 'rights:request')) throw forbidden();
  const purpose = input.purpose ?? 'assessment';
  if (!['student', 'guardian', 'school_legal_basis'].includes(input.actorType) || !['assessment', 'support', 'research'].includes(purpose) || typeof input.noticeVersion !== 'string' || !input.noticeVersion.trim()) throw new DomainError('CONSENT_INVALID', '参与记录类型、用途或告知版本无效');
  return store.transaction((state) => {
    const student = studentFor(state, auth.user, input.studentId);
    if (input.actorType === 'student' && (!isStudent(auth.user) || auth.user.id !== student.id)) throw forbidden('学生参与记录必须由本人提交');
    if (input.actorType === 'guardian' && (auth.user.role !== 'guardian' || !state.guardianLinks.some((link) => link.tenantId === auth.user.tenantId && link.studentId === student.id && link.guardianUserId === auth.user.id && link.status === 'verified'))) throw forbidden('监护人参与记录必须由已核验监护账号提交');
    if (input.actorType === 'school_legal_basis' && !can(auth.user, 'org:manage')) throw forbidden('学校合法依据记录需要校务授权');
    if (student.age !== undefined && student.age < 14 && input.actorType !== 'guardian') {
      throw new DomainError('GUARDIAN_CONSENT_REQUIRED', '不满 14 周岁需要监护人同意');
    }
    if (input.actorType === 'guardian' && !student.guardianVerified) throw new DomainError('GUARDIAN_NOT_VERIFIED', '监护关系尚未核验');
    const existing = state.consents.find((c) => c.tenantId === auth.user.tenantId && c.studentId === student.id && c.purpose === purpose && c.status === 'active');
    if (existing) return publicConsent(existing);
    const consent: ConsentRecord = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, purpose, noticeVersion: input.noticeVersion, actorType: input.actorType, actorId: auth.user.id, status: 'active', recordedAt: now() };
    state.consents.push(consent);
    audit(state, auth.user, 'consent.recorded', 'consent', consent.id, { purpose, actorType: input.actorType });
    return publicConsent(consent);
  });
}

/** Return purpose-bound consent metadata to the subject (or a verified
 * guardian for linked students). Actor identifiers and tenant internals are
 * intentionally omitted; the endpoint only renders participation state. */
export async function listMyConsents(store: Store, auth: AuthenticatedUser, purpose?: string): Promise<Array<Record<string, unknown>>> {
  if (!isStudent(auth.user) && auth.user.role !== 'guardian') throw forbidden();
  if (purpose !== undefined && !['assessment', 'support', 'research'].includes(purpose)) throw new DomainError('CONSENT_INVALID', '参与记录用途无效');
  return store.transaction((state) => {
    const studentIds = isStudent(auth.user)
      ? new Set([auth.user.id])
      : new Set(state.guardianLinks.filter((link) => link.tenantId === auth.user.tenantId && link.guardianUserId === auth.user.id && link.status === 'verified').map((link) => link.studentId));
    const consents = state.consents
      .filter((consent) => consent.tenantId === auth.user.tenantId && studentIds.has(consent.studentId) && (purpose === undefined || consent.purpose === purpose))
      .map(publicConsent);
    audit(state, auth.user, 'consent.own_listed', 'consent', 'self', { count: consents.length }, 'consent:read');
    return consents;
  });
}

export async function withdrawConsent(store: Store, auth: AuthenticatedUser, consentId: string): Promise<void> {
  return store.transaction((state) => {
    const consent = state.consents.find((candidate) => candidate.id === consentId && sameTenant(candidate, auth.user.tenantId));
    if (!consent) throw notFound();
    const student = state.students.find((candidate) => candidate.id === consent.studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
    const verifiedGuardian = student && auth.user.role === 'guardian' && state.guardianLinks.some((link) => link.tenantId === auth.user.tenantId && link.studentId === student.id && link.guardianUserId === auth.user.id && link.status === 'verified');
    if (!student || (auth.user.schoolId && student.schoolId !== auth.user.schoolId) || (!isStudent(auth.user) && !can(auth.user, 'org:manage') && !verifiedGuardian) || (isStudent(auth.user) && auth.user.id !== student.id)) throw forbidden();
    consent.status = 'withdrawn';
    consent.withdrawnAt = now();
    if (consent.purpose === 'assessment') revokeStudentAssessmentProcessing(state, auth.user.tenantId, student.id);
    audit(state, auth.user, 'consent.withdrawn', 'consent', consent.id, { purpose: consent.purpose });
    state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'consent.withdrawn', aggregateId: consent.id, payload: { studentId: student.id }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
  });
}

export async function previewImport(store: Store, auth: AuthenticatedUser, input: { schoolId: string; filename: string; rows: Array<Record<string, unknown>> }): Promise<{ batch: ImportBatch; rows: ImportRowResult[] }> {
  requirePermission(auth.user, 'import:write');
  if (typeof input.filename !== 'string' || !input.filename.trim() || !Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 10_000) throw new DomainError('IMPORT_INVALID', '导入文件名或行数无效');
  return store.transaction((state) => {
    const school = state.schools.find((candidate) => candidate.id === input.schoolId && sameTenant(candidate, auth.user.tenantId));
    if (!school) throw notFound();
    const batch: ImportBatch = { id: id(), tenantId: auth.user.tenantId, schoolId: school.id, createdBy: auth.user.id, filename: input.filename.slice(0, 200), status: 'previewed', mappingVersion: 1, rowCount: input.rows.length, validRowCount: 0, errorCount: 0, previewHash: importPreviewHash(input.rows), createdAt: now() };
    const seenExternalRefs = new Set<string>();
    const output: ImportRowResult[] = input.rows.map((raw, index) => {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const externalId = typeof source.externalId === 'string' ? source.externalId.trim() : '';
      const displayName = typeof source.displayName === 'string' ? source.displayName.trim() : '';
      const age = typeof source.age === 'number' ? source.age : Number(source.age);
      const classId = typeof source.classId === 'string' ? source.classId.trim() : '';
      const guardianValueValid = source.guardianVerified === undefined || typeof source.guardianVerified === 'boolean';
      const baseValid = Boolean(externalId && displayName && classId && externalId.length <= 200 && displayName.length <= 200 && classId.length <= 200 && Number.isInteger(age) && age >= 6 && age <= 19 && guardianValueValid);
      const externalRef = externalId ? hashExternal(externalId) : '';
      const duplicate = Boolean(externalRef && seenExternalRefs.has(externalRef));
      if (externalRef) seenExternalRefs.add(externalRef);
      const valid = baseValid && !duplicate;
      const message = valid ? undefined : duplicate ? '本批次 externalId 重复' : '需要 externalId、displayName、classId 和 6–19 岁整数 age；字段长度和 guardianVerified 类型也必须有效';
      const row: ImportRowResult = { id: id(), tenantId: auth.user.tenantId, batchId: batch.id, rowNumber: index + 1, status: valid ? 'valid' : 'error', message };
      if (valid) batch.validRowCount += 1; else batch.errorCount += 1;
      state.importRows.push(row);
      return row;
    });
    state.importBatches.push(batch);
    audit(state, auth.user, 'import.previewed', 'import_batch', batch.id, { rowCount: batch.rowCount, validRowCount: batch.validRowCount, errorCount: batch.errorCount });
    return { batch, rows: output };
  });
}

export async function commitImport(store: Store, auth: AuthenticatedUser, batchId: string, rows: Array<Record<string, unknown>>): Promise<ImportBatch> {
  requirePermission(auth.user, 'import:write');
  if (!Array.isArray(rows)) throw new DomainError('IMPORT_INVALID', '导入行必须是数组');
  return store.transaction((state) => {
    const batch = state.importBatches.find((candidate) => candidate.id === batchId && sameTenant(candidate, auth.user.tenantId));
    if (!batch) throw notFound();
    if (batch.status !== 'previewed') throw new DomainError('IMPORT_ALREADY_COMMITTED', '导入批次已处理');
    if (rows.length !== batch.rowCount) throw new DomainError('IMPORT_VERSION_CONFLICT', '提交行数与预检版本不一致', 409);
    if (!batch.previewHash || importPreviewHash(rows) !== batch.previewHash) throw new DomainError('IMPORT_VERSION_CONFLICT', '提交内容与预检版本不一致，请重新预检', 409);
    const seen = new Set<string>();
    let createdStudents = 0;
    for (const raw of rows) {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const externalId = typeof source.externalId === 'string' ? source.externalId.trim() : '';
      const displayName = typeof source.displayName === 'string' ? source.displayName.trim() : '';
      const age = typeof source.age === 'number' ? source.age : Number(source.age);
      const classId = typeof source.classId === 'string' ? source.classId.trim() : '';
      const refHash = hashExternal(externalId);
      if (!externalId || !displayName || !classId || !Number.isInteger(age) || age < 6 || age > 19 || seen.has(refHash)) continue;
      seen.add(refHash);
      const existing = state.students.find((student) => student.tenantId === auth.user.tenantId && student.externalRefHash === refHash);
      if (existing) continue;
      state.students.push({ id: id(), tenantId: auth.user.tenantId, schoolId: batch.schoolId, classId, externalRefHash: refHash, displayNameCiphertext: encrypt(displayName), age, guardianVerified: source.guardianVerified === true, active: true, createdAt: now() });
      createdStudents += 1;
    }
    batch.status = 'committed';
    for (const row of state.importRows.filter((candidate) => candidate.tenantId === auth.user.tenantId && candidate.batchId === batch.id && candidate.status === 'valid')) row.status = 'valid';
    audit(state, auth.user, 'import.committed', 'import_batch', batch.id, { rowCount: batch.rowCount, createdStudents });
    return batch;
  });
}

export async function createScale(store: Store, auth: AuthenticatedUser, input: Omit<ScaleVersion, 'id' | 'tenantId' | 'status' | 'createdBy' | 'approvedBy' | 'approvedAt'>): Promise<ScaleVersion> {
  requirePermission(auth.user, 'scale:write');
  if (!['synthetic_only', 'licensed'].includes(input.provenance)) throw new DomainError('SCALE_INVALID', '量表来源类型无效');
  if (input.provenance === 'licensed' && (typeof input.code !== 'string' || !input.code.trim())) throw new DomainError('LICENSE_UNAVAILABLE', '授权量表需要来源登记');
  if (typeof input.code !== 'string' || !input.code.trim() || input.code.length > 80 || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.version !== 'string' || !input.version.trim() || input.version.length > 40 || typeof input.scoringVersion !== 'string' || !input.scoringVersion.trim() || input.scoringVersion.length > 80 || typeof input.noticeVersion !== 'string' || !input.noticeVersion.trim() || input.noticeVersion.length > 80 || !Number.isInteger(input.minAge) || !Number.isInteger(input.maxAge) || input.minAge < 6 || input.maxAge > 19 || input.minAge > input.maxAge) throw new DomainError('SCALE_INVALID', '量表版本或适龄范围无效');
  if (input.population !== undefined && !['primary', 'middle', 'high', 'mixed'].includes(input.population)) throw new DomainError('SCALE_INVALID', '量表适用学段无效');
  if (input.language !== undefined && (typeof input.language !== 'string' || !input.language.trim() || input.language.length > 32)) throw new DomainError('SCALE_INVALID', '量表语言标识无效');
  if (input.dimensions !== undefined && (!Array.isArray(input.dimensions) || input.dimensions.length > 20 || input.dimensions.some((dimension) => typeof dimension !== 'string' || !dimension.trim() || dimension.length > 80))) throw new DomainError('SCALE_INVALID', '量表维度目录无效');
  if (input.licenseExpiresAt !== undefined && (typeof input.licenseExpiresAt !== 'string' || Number.isNaN(new Date(input.licenseExpiresAt).getTime()))) throw new DomainError('SCALE_INVALID', '量表授权到期时间无效');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200 || new Set(input.items.map((item) => item?.id)).size !== input.items.length || input.items.some((item) => !item || typeof item.id !== 'string' || !item.id || item.id.length > 80 || typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 5_000 || !Number.isInteger(item.min) || !Number.isInteger(item.max) || item.min > item.max || typeof item.reverse !== 'boolean' || typeof item.factor !== 'string' || !item.factor.trim() || item.factor.length > 100)) throw new DomainError('SCALE_INVALID', '量表题目结构无效');
  if (input.warningRule && (typeof input.warningRule !== 'object' || Array.isArray(input.warningRule) || !Number.isInteger(input.warningRule.threshold) || input.warningRule.threshold < 0 || !['attention', 'urgent'].includes(input.warningRule.level) || typeof input.warningRule.reason !== 'string' || !input.warningRule.reason.trim() || input.warningRule.reason.length > 500)) throw new DomainError('SCALE_INVALID', '预警规则结构无效');
  return store.transaction((state) => {
    if (state.scales.some((candidate) => candidate.tenantId === auth.user.tenantId && candidate.code === input.code && candidate.version === input.version)) {
      throw new DomainError('SCALE_VERSION_EXISTS', '同一量表版本已经存在', 409);
    }
    const scale: ScaleVersion = { ...input, id: id(), tenantId: auth.user.tenantId, status: 'draft', createdBy: auth.user.id };
    state.scales.push(scale);
    audit(state, auth.user, 'scale.created', 'scale_version', scale.id, { provenance: scale.provenance, version: scale.version });
    return scale;
  });
}

export async function approveScale(store: Store, auth: AuthenticatedUser, scaleId: string): Promise<ScaleVersion> {
  requirePermission(auth.user, 'scale:approve');
  return store.transaction((state) => {
    const scale = state.scales.find((candidate) => candidate.id === scaleId && sameTenant(candidate, auth.user.tenantId));
    if (!scale) throw notFound();
    if (scale.status === 'revoked') throw new DomainError('SCALE_REVOKED', '已撤销的量表版本不能重新启用，请创建新版本');
    if (scale.status === 'approved') throw new DomainError('SCALE_ALREADY_APPROVED', '量表版本已经通过专业审定');
    if (scale.createdBy && scale.createdBy === auth.user.id) throw new DomainError('SEPARATION_OF_DUTIES_REQUIRED', '量表作者不能审批自己的版本');
    if (scale.provenance === 'licensed' && !scale.reviewEvidenceRef) throw new DomainError('LICENSE_EVIDENCE_REQUIRED', '授权量表需要专业审定证据引用');
    if (scale.provenance === 'licensed' && !scale.licenseExpiresAt) throw new DomainError('LICENSE_EXPIRY_REQUIRED', '授权量表必须登记明确的授权到期时间');
    if (scale.licenseExpiresAt && Number.isNaN(new Date(scale.licenseExpiresAt).getTime())) throw new DomainError('LICENSE_EXPIRY_INVALID', '量表授权到期时间无效');
    if (scale.licenseExpiresAt && new Date(scale.licenseExpiresAt) <= new Date()) throw new DomainError('LICENSE_EXPIRED', '量表授权已到期，不能通过专业审定');
    assertUsableScale({ ...scale, status: 'approved' });
    scale.status = 'approved'; scale.approvedBy = auth.user.id; scale.approvedAt = now();
    audit(state, auth.user, 'scale.approved', 'scale_version', scale.id, { version: scale.version });
    return scale;
  });
}

export async function createCampaign(store: Store, auth: AuthenticatedUser, input: { schoolId: string; name: string; purpose: Campaign['purpose']; academicYear: string; opensAt: string; closesAt: string; scaleVersionId: string; participantStudentIds: string[] }): Promise<Campaign> {
  requirePermission(auth.user, 'campaign:write');
  return store.transaction((state) => {
    const school = state.schools.find((candidate) => candidate.id === input.schoolId && sameTenant(candidate, auth.user.tenantId));
    const scale = state.scales.find((candidate) => candidate.id === input.scaleVersionId && sameTenant(candidate, auth.user.tenantId));
    if (!school || !scale) throw notFound();
    if (auth.user.schoolId && auth.user.schoolId !== school.id) throw forbidden();
    if (!['screening', 'survey'].includes(input.purpose) || typeof input.name !== 'string' || !input.name.trim() || typeof input.academicYear !== 'string' || !input.academicYear.trim() || !validDate(input.opensAt) || !validDate(input.closesAt) || new Date(input.opensAt) >= new Date(input.closesAt) || !Array.isArray(input.participantStudentIds)) throw new DomainError('CAMPAIGN_INVALID', '任务名称、用途或时间窗无效');
    const uniqueStudents = [...new Set(input.participantStudentIds)];
    if (uniqueStudents.some((studentId) => !state.students.some((student) => student.id === studentId && student.schoolId === school.id && sameTenant(student, auth.user.tenantId) && student.active))) throw forbidden();
    const campaign: Campaign = { id: id(), tenantId: auth.user.tenantId, schoolId: school.id, name: input.name.trim(), purpose: input.purpose, state: 'draft', academicYear: input.academicYear, opensAt: input.opensAt, closesAt: input.closesAt, scaleVersionId: scale.id, reportVisibility: 'professional_review', participantStudentIds: uniqueStudents, createdBy: auth.user.id, createdAt: now() };
    state.campaigns.push(campaign); audit(state, auth.user, 'campaign.created', 'campaign', campaign.id, { participantCount: uniqueStudents.length }); return campaign;
  });
}

export async function publishCampaign(store: Store, auth: AuthenticatedUser, campaignId: string): Promise<Campaign> {
  requirePermission(auth.user, 'campaign:write');
  return store.transaction((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && sameTenant(candidate, auth.user.tenantId));
    if (!campaign) throw notFound();
    if (auth.user.schoolId && auth.user.schoolId !== campaign.schoolId) throw forbidden();
    const scale = state.scales.find((candidate) => candidate.id === campaign.scaleVersionId && sameTenant(candidate, auth.user.tenantId));
    if (!scale) throw notFound();
    assertUsableScale(scale);
    if (campaign.state !== 'draft' && campaign.state !== 'approved') throw new DomainError('CAMPAIGN_STATE_INVALID', '任务当前状态不能发布');
    const studentList = campaign.participantStudentIds.map((studentId) => state.students.find((student) => student.id === studentId && sameTenant(student, auth.user.tenantId))).filter((student): student is Student => Boolean(student));
    if (studentList.length !== new Set(campaign.participantStudentIds).size || studentList.some((student) => !student.active || student.schoolId !== campaign.schoolId)) throw new DomainError('STUDENT_NOT_ELIGIBLE', '名单中有不存在、已停用或已转校的学生');
    if (studentList.some((student) => !ageAllowed(student, scale))) throw new DomainError('AGE_REVIEW_REQUIRED', '名单中有不适龄或年龄未知的学生');
    if (studentList.some((student) => !activeConsent(state, student.id, 'assessment', auth.user.tenantId))) throw new DomainError('CONSENT_REQUIRED', '名单中有学生缺少有效测评参与记录');
    const existing = new Set(state.assignments.filter((a) => a.tenantId === auth.user.tenantId && a.campaignId === campaign.id).map((a) => a.studentId));
    for (const student of studentList) {
      if (existing.has(student.id)) continue;
      const exception = state.frequencyReservations.find((reservation) => reservation.tenantId === auth.user.tenantId && reservation.studentId === student.id && reservation.academicYear === campaign.academicYear && reservation.campaignId === campaign.id && reservation.status === 'exception');
      if (exception) {
        state.assignments.push({ id: id(), tenantId: auth.user.tenantId, campaignId: campaign.id, studentId: student.id, frequencyReservationId: exception.id, status: 'assigned', createdAt: now() });
        continue;
      }
      const frequencyKey = `${student.id}:${campaign.academicYear}`;
      const used = state.frequencyReservations.find((r) => r.tenantId === auth.user.tenantId && `${r.studentId}:${r.academicYear}` === frequencyKey && r.status !== 'released');
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

/** Record an approved same-year re-evaluation exception before a campaign is published. */
export async function approveFrequencyException(store: Store, auth: AuthenticatedUser, campaignId: string, input: { studentId: string; reason: string }): Promise<PublicFrequencyReservation> {
  requirePermission(auth.user, 'frequency:approve');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000 || /[\0\r\n]/.test(input.reason)) throw new DomainError('FREQUENCY_EXCEPTION_REASON_REQUIRED', '复评例外需要记录用途和依据');
  return store.transaction((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && candidate.tenantId === auth.user.tenantId);
    const student = state.students.find((candidate) => candidate.id === input.studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
    const scale = campaign ? state.scales.find((candidate) => candidate.id === campaign.scaleVersionId && candidate.tenantId === auth.user.tenantId) : undefined;
    if (!campaign || !student || !scale) throw notFound();
    if (campaign.state !== 'draft' && campaign.state !== 'approved') throw new DomainError('CAMPAIGN_STATE_INVALID', '只能为尚未发布的任务申请复评例外');
    if (auth.user.schoolId && auth.user.schoolId !== campaign.schoolId) throw forbidden();
    if (student.schoolId !== campaign.schoolId || !ageAllowed(student, scale)) throw new DomainError('AGE_REVIEW_REQUIRED', '学生不属于任务学校或不在量表适龄范围');
    if (!activeConsent(state, student.id, 'assessment', auth.user.tenantId)) throw new DomainError('CONSENT_REQUIRED', '复评前需要有效的测评参与记录');
    const existingException = state.frequencyReservations.find((reservation) => reservation.tenantId === auth.user.tenantId && reservation.studentId === student.id && reservation.academicYear === campaign.academicYear && reservation.campaignId === campaign.id && reservation.status === 'exception');
    if (existingException) {
      existingException.approvedBy = auth.user.id;
      existingException.reasonCiphertext = encrypt({ reason: input.reason.trim().slice(0, 1000) });
      existingException.reason = undefined;
      audit(state, auth.user, 'frequency.exception_updated', 'frequency_reservation', existingException.id, { campaignId, studentId: student.id });
      return publicFrequencyReservation(existingException);
    }
    const reservation: FrequencyReservation = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, academicYear: campaign.academicYear, purpose: 'assessment', status: 'exception', campaignId: campaign.id, approvedBy: auth.user.id, reasonCiphertext: encrypt({ reason: input.reason.trim().slice(0, 1000) }), createdAt: now() };
    state.frequencyReservations.push(reservation);
    audit(state, auth.user, 'frequency.exception_approved', 'frequency_reservation', reservation.id, { campaignId, studentId: student.id });
    return publicFrequencyReservation(reservation);
  });
}

export async function beginAttempt(store: Store, auth: AuthenticatedUser, assignmentId: string): Promise<{ attempt: Attempt; scale: ScaleVersion }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const assignment = state.assignments.find((candidate) => candidate.id === assignmentId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!assignment) throw notFound();
    const campaign = state.campaigns.find((candidate) => candidate.id === assignment.campaignId && sameTenant(candidate, auth.user.tenantId));
    const student = state.students.find((candidate) => candidate.id === auth.user.id && sameTenant(candidate, auth.user.tenantId));
    const scale = campaign ? state.scales.find((candidate) => candidate.id === campaign.scaleVersionId && sameTenant(candidate, auth.user.tenantId)) : undefined;
    if (!campaign || !student || !scale) throw notFound();
    if (!['open', 'scheduled'].includes(campaign.state) || new Date(campaign.opensAt) > new Date() || new Date(campaign.closesAt) <= new Date()) throw new DomainError('CAMPAIGN_CLOSED', '任务当前不在开放时间');
    assertUsableScale(scale);
    if (!activeConsent(state, student.id, 'assessment', auth.user.tenantId)) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    if (!ageAllowed(student, scale)) throw new DomainError('AGE_REVIEW_REQUIRED', '年龄不在该方案适用范围');
    if (!['assigned', 'started'].includes(assignment.status)) throw new DomainError('ASSIGNMENT_NOT_AVAILABLE', '该任务已结束或不再接受答题', 409);
    const reservation = state.frequencyReservations.find((candidate) => candidate.id === assignment.frequencyReservationId && candidate.tenantId === auth.user.tenantId);
    if (!reservation || !['reserved', 'exception'].includes(reservation.status)) throw new DomainError('FREQUENCY_REVIEW_REQUIRED', '该测评场次已释放或已被占用', 409);
    const current = state.attempts.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.assignmentId === assignment.id);
    if (current) return { attempt: current, scale };
    const attempt: Attempt = { id: id(), tenantId: auth.user.tenantId, assignmentId: assignment.id, studentId: student.id, scaleVersionId: scale.id, state: 'in_progress', currentRevision: 0, startedAt: now() };
    state.attempts.push(attempt); assignment.status = 'started'; audit(state, auth.user, 'attempt.started', 'attempt', attempt.id, {}, 'assessment'); return { attempt, scale };
  });
}

/** Return the student's latest server-confirmed draft for resume after a reload. */
export async function getAttempt(store: Store, auth: AuthenticatedUser, attemptId: string): Promise<{ attempt: Attempt; answers: Record<string, unknown> }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const attempt = state.attempts.find((candidate) => candidate.id === attemptId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!attempt) throw notFound();
    if (attempt.state !== 'in_progress') throw new DomainError('ATTEMPT_NOT_RESUMABLE', '该答题已提交或已关闭', 409);
    assertAttemptWritable(state, attempt);
    if (!activeConsent(state, attempt.studentId, 'assessment', auth.user.tenantId)) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    const revision = state.answerRevisions.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.attemptId === attempt.id && candidate.revision === attempt.currentRevision);
    const answers = revision ? decrypt<Record<string, unknown>>(revision.answersCiphertext) : {};
    audit(state, auth.user, 'attempt.draft_read', 'attempt', attempt.id, { revision: attempt.currentRevision }, 'assessment');
    return { attempt, answers };
  });
}

function answersFrom(state: DatabaseState, attempt: Attempt): Record<string, unknown> {
  const revision = state.answerRevisions.find((candidate) => candidate.tenantId === attempt.tenantId && candidate.attemptId === attempt.id && candidate.revision === attempt.currentRevision);
  if (!revision) throw new DomainError('ANSWERS_NOT_SAVED', '尚未保存答题内容');
  return decrypt<Record<string, unknown>>(revision.answersCiphertext);
}

/** Re-check the server-side task window and frequency reservation on every
 * draft mutation, not only when the student first opens a task. A campaign
 * may be paused/closed, a reservation may be released, or consent may be
 * withdrawn while a browser tab is still open. */
function assertAttemptWritable(state: DatabaseState, attempt: Attempt): void {
  const assignment = state.assignments.find((candidate) => candidate.tenantId === attempt.tenantId && candidate.id === attempt.assignmentId);
  const campaign = assignment && state.campaigns.find((candidate) => candidate.tenantId === attempt.tenantId && candidate.id === assignment.campaignId);
  const reservation = assignment && state.frequencyReservations.find((candidate) => candidate.tenantId === attempt.tenantId && candidate.id === assignment.frequencyReservationId);
  if (!assignment || !campaign) throw notFound();
  if (!['open', 'scheduled'].includes(campaign.state) || !validDate(campaign.opensAt) || !validDate(campaign.closesAt) || new Date(campaign.opensAt) > new Date() || new Date(campaign.closesAt) <= new Date()) {
    attempt.state = 'expired';
    if (['assigned', 'started'].includes(assignment.status)) assignment.status = 'expired';
    releaseUnusedCampaignReservations(state, attempt.tenantId, campaign.id);
    throw new DomainError('CAMPAIGN_CLOSED', '任务当前不在开放时间', 409);
  }
  if (!reservation || !['reserved', 'exception'].includes(reservation.status)) throw new DomainError('FREQUENCY_REVIEW_REQUIRED', '该测评场次已释放或已被占用', 409);
}

export async function saveAnswers(store: Store, auth: AuthenticatedUser, attemptId: string, input: { expectedRevision: number; answers: Record<string, unknown> }): Promise<{ revision: number; savedAt: string }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  if (!Number.isInteger(input.expectedRevision) || !input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw new DomainError('ANSWER_SET_INVALID', '答题内容格式无效');
  return store.transaction((state) => {
    const attempt = state.attempts.find((candidate) => candidate.id === attemptId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!attempt || attempt.state !== 'in_progress') throw notFound();
    if (!activeConsent(state, attempt.studentId, 'assessment', auth.user.tenantId)) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    assertAttemptWritable(state, attempt);
    if (attempt.currentRevision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', '答题内容已在其他窗口更新', 409, { currentRevision: attempt.currentRevision });
    const scale = state.scales.find((candidate) => candidate.id === attempt.scaleVersionId && sameTenant(candidate, auth.user.tenantId));
    if (!scale) throw notFound();
    const allowed = new Set(scale.items.map((item) => item.id));
    if (Object.keys(input.answers).some((key) => !allowed.has(key))) throw new DomainError('ANSWER_ITEM_INVALID', '答题项不属于当前方案');
    const savedAt = now(); const revision = attempt.currentRevision + 1;
    state.answerRevisions.push({ id: id(), tenantId: auth.user.tenantId, attemptId, revision, answersCiphertext: encrypt(input.answers), savedAt, actorId: auth.user.id });
    attempt.currentRevision = revision; audit(state, auth.user, 'attempt.answers_saved', 'attempt', attempt.id, { revision }, 'assessment'); return { revision, savedAt };
  });
}

export async function submitAttempt(store: Store, auth: AuthenticatedUser, attemptId: string, idempotencyKey: string): Promise<{ submissionId: string; state: Attempt['state']; scoreRunId?: string }> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length < 12 || idempotencyKey.length > 120) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '需要有效的幂等键');
  return store.transaction((state) => {
    const attempt = state.attempts.find((candidate) => candidate.id === attemptId && sameTenant(candidate, auth.user.tenantId) && candidate.studentId === auth.user.id);
    if (!attempt) throw notFound();
    if (!activeConsent(state, attempt.studentId, 'assessment', auth.user.tenantId)) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    const existing = state.submissions.find((submission) => submission.tenantId === auth.user.tenantId && submission.attemptId === attempt.id);
    if (existing) {
      if (existing.idempotencyKey !== idempotencyKey) throw new DomainError('IDEMPOTENCY_CONFLICT', '该答卷已经提交', 409);
      return { submissionId: existing.id, state: attempt.state, scoreRunId: state.scoreRuns.find((run) => run.tenantId === auth.user.tenantId && run.submissionId === existing.id)?.id };
    }
    if (attempt.state !== 'in_progress') throw new DomainError('ATTEMPT_NOT_SUBMITTABLE', '该答题已提交或已关闭', 409);
    assertAttemptWritable(state, attempt);
    const answers = answersFrom(state, attempt);
    const scale = state.scales.find((candidate) => candidate.id === attempt.scaleVersionId && sameTenant(candidate, auth.user.tenantId));
    if (!scale) throw notFound();
    const answerRevision = state.answerRevisions.find((r) => r.tenantId === auth.user.tenantId && r.attemptId === attempt.id && r.revision === attempt.currentRevision);
    if (!answerRevision) throw new DomainError('ANSWERS_NOT_SAVED', '尚未保存答题内容');
    const submission: import('./types.js').Submission = { id: id(), tenantId: auth.user.tenantId, attemptId: attempt.id, answerRevisionId: answerRevision.id, idempotencyKey, contentHash: contentHash(answers), submittedAt: now() };
    state.submissions.push(submission); attempt.state = 'scoring_pending'; attempt.submittedAt = submission.submittedAt; attempt.submissionId = submission.id;
    state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'assessment.submitted', aggregateId: attempt.id, payload: { submissionId: submission.id, scaleVersionId: scale.id }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
    // Preflight the deterministic rule in the submission transaction so an urgent
    // candidate has its own high-priority outbox path instead of waiting for report work.
    const preflight = score(scale, answers);
    if (preflight.validity === 'valid' && scale.warningRule && preflight.total >= scale.warningRule.threshold) {
      state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'risk.triage', aggregateId: attempt.id, payload: { submissionId: submission.id }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
    }
    audit(state, auth.user, 'attempt.submitted', 'submission', submission.id, { attemptId: attempt.id }, 'assessment'); return { submissionId: submission.id, state: attempt.state };
  });
}

export async function drainOutbox(store: Store, limit = 50): Promise<{ processed: number; failed: number }> {
  let processed = 0; let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const event = await store.read((state) => state.outboxEvents.filter((candidate) => candidate.status === 'pending' && new Date(candidate.availableAt) <= new Date()).sort((left, right) => {
      const priority = (value: string) => ['risk.triage', 'risk.signal_created', 'risk.escalation'].includes(value) ? 0 : 1;
      return priority(left.type) - priority(right.type) || left.createdAt.localeCompare(right.createdAt);
    })[0]);
    if (!event) break;
    try {
      await processOutboxEvent(store, event.id);
      processed += 1;
    } catch (error) {
      failed += 1;
      await store.transaction((state) => {
        const current = state.outboxEvents.find((candidate) => candidate.id === event.id);
        if (!current) return;
        // Only persist a machine-readable error code.  Copying an arbitrary
        // exception message into delivery metadata could leak a decrypted
        // value if a future handler includes request data in its error.
        const rawErrorCode = error instanceof Error ? error.message : '';
        const safeErrorCode = /^[A-Z][A-Z0-9_:-]{0,63}$/.test(rawErrorCode) ? rawErrorCode : 'OUTBOX_PROCESSING_FAILED';
        state.deliveryAttempts.push({ id: id(), tenantId: current.tenantId, outboxEventId: current.id, channel: 'in_app', status: 'failed', attemptedAt: now(), errorCode: safeErrorCode });
        current.attempts += 1; current.status = current.attempts >= 5 ? 'dead_letter' : 'pending'; current.availableAt = new Date(Date.now() + Math.min(60_000, 2 ** current.attempts * 1000)).toISOString();
      });
    }
  }
  return { processed, failed };
}

function upsertScoreRuleSignal(state: DatabaseState, input: { tenantId: string; studentId: string; submissionId: string; scoreRunId?: string; scale: ScaleVersion }): RiskSignal | undefined {
  const rule = input.scale.warningRule;
  if (!rule) return undefined;
  const existing = state.riskSignals.find((signal) => signal.tenantId === input.tenantId && signal.source === 'score_rule' && signal.submissionId === input.submissionId);
  if (existing) {
    if (input.scoreRunId) existing.scoreRunId = input.scoreRunId;
    return existing;
  }
  const signal: RiskSignal = { id: id(), tenantId: input.tenantId, studentId: input.studentId, source: 'score_rule', submissionId: input.submissionId, scoreRunId: input.scoreRunId, ruleVersion: input.scale.scoringVersion, level: rule.level, reasonCiphertext: encrypt({ reason: rule.reason }), createdAt: now(), status: 'open' };
  state.riskSignals.push(signal);
  let riskCase = state.riskCases.find((candidate) => candidate.tenantId === input.tenantId && candidate.studentId === signal.studentId && ['pending_review', 'confirmed', 'assigned', 'in_support', 'follow_up', 'closure_requested'].includes(candidate.state));
  if (!riskCase) { riskCase = { id: id(), tenantId: input.tenantId, studentId: signal.studentId, state: 'pending_review', priority: signal.level, signalIds: [], createdAt: now(), updatedAt: now() }; state.riskCases.push(riskCase); }
  riskCase.signalIds.push(signal.id);
  if (riskCase.priority !== 'urgent' && signal.level === 'urgent') riskCase.priority = 'urgent';
  riskCase.updatedAt = now();
  state.outboxEvents.push({ id: id(), tenantId: input.tenantId, type: 'risk.signal_created', aggregateId: riskCase.id, payload: { signalId: signal.id, level: signal.level }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
  return signal;
}

async function processOutboxEvent(store: Store, eventId: string): Promise<void> {
  await store.transaction((state) => {
    const event = state.outboxEvents.find((candidate) => candidate.id === eventId && candidate.status === 'pending');
    if (!event) return;
    if (event.type === 'assessment.submitted') {
      const submission = state.submissions.find((candidate) => candidate.id === String(event.payload.submissionId) && sameTenant(candidate, event.tenantId));
      const attempt = submission ? state.attempts.find((candidate) => candidate.id === submission.attemptId && sameTenant(candidate, event.tenantId)) : undefined;
      const scale = attempt ? state.scales.find((candidate) => candidate.id === attempt.scaleVersionId && sameTenant(candidate, event.tenantId)) : undefined;
      if (!submission || !attempt || !scale) throw new Error('SCORING_REFERENCE_MISSING');
      const answers = answersFrom(state, attempt);
      const output = score(scale, answers);
      const run = state.scoreRuns.find((candidate) => candidate.tenantId === event.tenantId && candidate.submissionId === submission.id);
      if (run) { event.status = 'published'; return; }
      const scoreRun = { id: id(), tenantId: event.tenantId, submissionId: submission.id, scoringVersion: scale.scoringVersion, status: output.validity === 'valid' ? 'completed' as const : 'failed' as const, factorScores: output.factorScores, total: output.total, validity: output.validity, completedAt: now(), errorCode: output.invalidReason };
      state.scoreRuns.push(scoreRun); attempt.state = output.validity === 'valid' ? 'scored' : 'invalid';
      const assignment = state.assignments.find((candidate) => candidate.tenantId === event.tenantId && candidate.id === attempt.assignmentId);
      if (assignment) assignment.status = 'completed';
      const reservation = assignment ? state.frequencyReservations.find((candidate) => candidate.tenantId === event.tenantId && candidate.id === assignment.frequencyReservationId) : undefined;
      // An exception reservation remains an auditable exception marker; the original
      // annual reservation stays authoritative for the frequency guard.
      if (reservation && reservation.status !== 'exception') reservation.status = 'consumed';
      if (output.validity === 'invalid') {
        state.outboxEvents.push({ id: id(), tenantId: event.tenantId, type: 'score.failed', aggregateId: scoreRun.id, payload: { submissionId: submission.id, reason: output.invalidReason ?? 'INVALID_ANSWERS' }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
        audit(state, undefined, 'score.failed', 'score_run', scoreRun.id, { validity: output.validity }, undefined, event.tenantId);
        event.status = 'published';
        return;
      }
      const report: import('./types.js').ReportVersion = { id: id(), tenantId: event.tenantId, studentId: attempt.studentId, scoreRunId: scoreRun.id, state: 'pending_review', title: scale.title, summaryCiphertext: encrypt({ total: output.total, factorScores: output.factorScores, text: '这是演示反馈，不构成心理诊断；如有困扰请联系学校心理专业人员。' }), limitationsCiphertext: encrypt({ text: '演示方案仅用于软件流程验证，不代表有效量表、医学诊断或风险结论。' }), createdAt: now() };
      state.reports.push(report);
      if (output.validity === 'valid' && scale.warningRule && output.total >= scale.warningRule.threshold) upsertScoreRuleSignal(state, { tenantId: event.tenantId, studentId: attempt.studentId, submissionId: submission.id, scoreRunId: scoreRun.id, scale });
      audit(state, undefined, 'score.completed', 'score_run', scoreRun.id, { validity: output.validity, reportId: report.id }, undefined, event.tenantId);
    }
    if (event.type === 'risk.triage') {
      const submission = state.submissions.find((candidate) => candidate.id === String(event.payload.submissionId) && sameTenant(candidate, event.tenantId));
      const attempt = submission ? state.attempts.find((candidate) => candidate.id === submission.attemptId && sameTenant(candidate, event.tenantId)) : undefined;
      const scale = attempt ? state.scales.find((candidate) => candidate.id === attempt.scaleVersionId && sameTenant(candidate, event.tenantId)) : undefined;
      if (!submission || !attempt || !scale) throw new Error('TRIAGE_REFERENCE_MISSING');
      const output = score(scale, answersFrom(state, attempt));
      if (output.validity === 'valid' && scale.warningRule && output.total >= scale.warningRule.threshold) {
        const signal = upsertScoreRuleSignal(state, { tenantId: event.tenantId, studentId: attempt.studentId, submissionId: submission.id, scale });
        if (signal) audit(state, undefined, 'risk.triage_created', 'risk_signal', signal.id, { level: signal.level }, undefined, event.tenantId);
      }
    }
    if (event.type === 'risk.signal_created' || event.type === 'risk.escalation') {
      if (event.type === 'risk.escalation' && !state.riskCases.some((riskCase) => riskCase.tenantId === event.tenantId && riskCase.id === event.aggregateId)) throw new Error('ESCALATION_REFERENCE_MISSING');
      const existingDelivery = state.deliveryAttempts.find((attempt) => attempt.tenantId === event.tenantId && attempt.outboxEventId === event.id && attempt.channel === 'in_app');
      if (!existingDelivery) {
        state.deliveryAttempts.push({ id: id(), tenantId: event.tenantId, outboxEventId: event.id, channel: 'in_app', status: 'sent', attemptedAt: now() });
      }
    }
    // Notification delivery is recorded separately; case acknowledgement remains a human action.
    event.status = 'published';
  });
}

export async function listReports(store: Store, auth: AuthenticatedUser, studentId?: string): Promise<Array<Record<string, unknown>>> {
  if (!isProfessional(auth.user) && !isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const reports = state.reports.filter((report) => sameTenant(report, auth.user.tenantId) && (!studentId || report.studentId === studentId));
    const visible = reports.filter((report) => isStudent(auth.user) ? report.studentId === auth.user.id && report.state === 'released' : professionalCanReadStudent(state, auth, report.studentId));
    audit(state, auth.user, 'report.listed', 'report', studentId ?? 'self', { count: visible.length }, 'report:read');
    return visible.map((report) => ({ id: report.id, studentId: report.studentId, title: report.title, state: report.state, scoreRunId: report.scoreRunId, createdAt: report.createdAt, releasedAt: report.releasedAt, summary: report.state === 'released' || isProfessional(auth.user) ? decrypt(report.summaryCiphertext) : undefined }));
  });
}

export async function getStudentArchive(store: Store, auth: AuthenticatedUser, studentId: string, purpose: string): Promise<Record<string, unknown>> {
  if (!isProfessional(auth.user)) throw forbidden();
  const normalizedPurpose = typeof purpose === 'string' ? purpose.trim().slice(0, 100) : '';
  if (!normalizedPurpose) throw new DomainError('PURPOSE_REQUIRED', '查看心理档案需要记录用途');
  const allowedPurposes = new Set(['case_review', 'report_review', 'support_follow_up']);
  if (!allowedPurposes.has(normalizedPurpose)) throw new DomainError('PURPOSE_INVALID', '查看心理档案的用途不在批准范围内');
  return store.transaction((state) => {
    if (!professionalCanReadStudent(state, auth, studentId)) throw notFound();
    const student = state.students.find((candidate) => candidate.id === studentId && candidate.tenantId === auth.user.tenantId && candidate.active)!;
    const reports = state.reports.filter((report) => report.tenantId === auth.user.tenantId && report.studentId === studentId).map((report) => ({ id: report.id, title: report.title, state: report.state, scoreRunId: report.scoreRunId, createdAt: report.createdAt, releasedAt: report.releasedAt, summary: decrypt(report.summaryCiphertext), limitations: decrypt(report.limitationsCiphertext) }));
    const cases = state.riskCases.filter((riskCase) => riskCase.tenantId === auth.user.tenantId && riskCase.studentId === studentId && (auth.user.role === 'professional_lead' || riskCase.assignedTo === auth.user.id)).map((riskCase) => ({ id: riskCase.id, state: riskCase.state, priority: riskCase.priority, signalCount: riskCase.signalIds.length, assignedTo: riskCase.assignedTo, updatedAt: riskCase.updatedAt }));
    const profileResponses = state.profileResponses.filter((response) => response.tenantId === auth.user.tenantId && response.studentId === studentId).map((response) => ({ id: response.id, schemaId: response.schemaId, values: decrypt(response.valuesCiphertext), submittedAt: response.submittedAt }));
    audit(state, auth.user, 'archive.viewed', 'student_archive', studentId, { purpose: normalizedPurpose, reportCount: reports.length, caseCount: cases.length, profileResponseCount: profileResponses.length }, normalizedPurpose);
    return { studentId: student.id, schoolId: student.schoolId, classId: student.classId, age: student.age, reports, cases, profileResponses, note: '心理档案仅供授权专业工作使用；筛查信息不构成诊断。' };
  });
}

export async function approveReport(store: Store, auth: AuthenticatedUser, reportId: string, release = false): Promise<void> {
  requirePermission(auth.user, 'report:approve');
  return store.transaction((state) => {
    const report = state.reports.find((candidate) => candidate.id === reportId && sameTenant(candidate, auth.user.tenantId));
    if (!report || report.state === 'revoked') throw notFound();
    if (!professionalCanReadStudent(state, auth, report.studentId)) throw notFound();
    if (release && report.state !== 'approved') throw new DomainError('REPORT_STATE_INVALID', '报告必须先完成专业审核才能发布');
    if (!release && report.state !== 'pending_review') throw new DomainError('REPORT_STATE_INVALID', '报告当前状态不能审核');
    report.state = release ? 'released' : 'approved'; report.approvedBy = auth.user.id; report.approvedAt = now(); if (release) report.releasedAt = now();
    audit(state, auth.user, release ? 'report.released' : 'report.approved', 'report', report.id, {});
  });
}

export async function createRiskSignal(store: Store, auth: AuthenticatedUser, input: { studentId: string; level: RiskSignal['level']; reason: string; source?: RiskSignal['source'] }): Promise<PublicRiskCase> {
  if (isStudent(auth.user)) requirePermission(auth.user, 'self:help'); else requirePermission(auth.user, 'case:review');
  if (!['attention', 'urgent'].includes(input.level) || (input.source !== undefined && !['score_rule', 'self_request', 'staff_observation', 'external_referral'].includes(input.source)) || typeof input.reason !== 'string' || !input.reason.trim()) throw new DomainError('RISK_SIGNAL_INVALID', '线索等级、来源或说明无效');
  const source = input.source ?? (isStudent(auth.user) ? 'self_request' : 'staff_observation');
  if ((isStudent(auth.user) && source !== 'self_request') || (!isStudent(auth.user) && !['staff_observation', 'external_referral'].includes(source))) throw new DomainError('RISK_SIGNAL_SOURCE_INVALID', '该来源只能由对应工作流生成');
  return store.transaction((state) => {
    const student = studentFor(state, auth.user, input.studentId);
    const signal: RiskSignal = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, source, level: input.level, reasonCiphertext: encrypt({ reason: input.reason.slice(0, 2000) }), createdAt: now(), status: 'open' };
    state.riskSignals.push(signal);
    let riskCase = state.riskCases.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.studentId === student.id && ['pending_review', 'confirmed', 'assigned', 'in_support', 'follow_up', 'closure_requested'].includes(candidate.state));
    if (!riskCase) { riskCase = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, state: 'pending_review', priority: signal.level, signalIds: [], createdAt: now(), updatedAt: now() }; state.riskCases.push(riskCase); }
    riskCase.signalIds.push(signal.id); riskCase.priority = riskCase.priority === 'urgent' || signal.level === 'attention' ? riskCase.priority : signal.level; riskCase.updatedAt = now();
    state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'risk.signal_created', aggregateId: riskCase.id, payload: { signalId: signal.id, level: signal.level }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
    audit(state, auth.user, 'risk.signal_created', 'risk_case', riskCase.id, { level: signal.level, source: signal.source }, 'support'); return publicRiskCase(riskCase);
  });
}

export async function listCases(store: Store, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!isProfessional(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const cases = state.riskCases.filter((candidate) => sameTenant(candidate, auth.user.tenantId) && (!auth.user.schoolId || state.students.some((student) => student.id === candidate.studentId && student.schoolId === auth.user.schoolId)) && (auth.user.role === 'professional_lead' || candidate.assignedTo === auth.user.id));
    audit(state, auth.user, 'risk.case_listed', 'risk_case', 'tenant', { count: cases.length }, 'case:read');
    return cases.map((riskCase) => ({ id: riskCase.id, studentId: riskCase.studentId, state: riskCase.state, priority: riskCase.priority, assignedTo: riskCase.assignedTo, signalCount: riskCase.signalIds.length, createdAt: riskCase.createdAt, updatedAt: riskCase.updatedAt }));
  });
}

function caseFor(state: DatabaseState, auth: AuthenticatedUser, caseId: string): RiskCase {
  const riskCase = state.riskCases.find((candidate) => candidate.id === caseId && sameTenant(candidate, auth.user.tenantId));
  if (!riskCase) throw notFound();
  if (auth.user.schoolId && !state.students.some((student) => student.tenantId === auth.user.tenantId && student.id === riskCase.studentId && student.schoolId === auth.user.schoolId)) throw notFound();
  return riskCase;
}

export async function reviewCase(store: Store, auth: AuthenticatedUser, caseId: string, input: { decision: 'dismiss' | 'confirm'; note: string }): Promise<PublicRiskCase> {
  requirePermission(auth.user, 'case:review');
  if (!isProfessional(auth.user)) throw forbidden();
  if (!['dismiss', 'confirm'].includes(input.decision) || typeof input.note !== 'string' || !input.note.trim()) throw new DomainError('CASE_REVIEW_INVALID', '复核决定或说明无效');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (auth.user.role === 'counselor' && riskCase.assignedTo !== auth.user.id) throw forbidden();
    if (!['pending_review', 'closure_requested'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案当前状态不能复核');
    const review: RiskReview = { id: id(), tenantId: auth.user.tenantId, caseId, reviewerId: auth.user.id, decision: input.decision, noteCiphertext: encrypt({ note: input.note.slice(0, 4000) }), createdAt: now() };
    state.riskReviews.push(review);
    riskCase.state = input.decision === 'dismiss' ? 'dismissed' : 'confirmed'; riskCase.updatedAt = now();
    for (const signal of state.riskSignals.filter((candidate) => candidate.tenantId === auth.user.tenantId && riskCase.signalIds.includes(candidate.id))) signal.status = input.decision === 'dismiss' ? 'dismissed' : 'reviewed';
    audit(state, auth.user, 'risk.case_reviewed', 'risk_case', caseId, { decision: input.decision }, 'support'); return publicRiskCase(riskCase);
  });
}

export async function assignCase(store: Store, auth: AuthenticatedUser, caseId: string, assigneeId: string): Promise<PublicRiskCase> {
  requirePermission(auth.user, 'case:assign');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    const assignee = state.users.find((candidate) => candidate.id === assigneeId && sameTenant(candidate, auth.user.tenantId) && isProfessional(candidate));
    if (!assignee || (auth.user.schoolId && assignee.schoolId !== auth.user.schoolId)) throw notFound();
    if (!['confirmed', 'assigned'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案尚未确认');
    riskCase.assignedTo = assignee.id; riskCase.state = 'assigned'; riskCase.updatedAt = now(); audit(state, auth.user, 'risk.case_assigned', 'risk_case', caseId, { assigneeId }); return publicRiskCase(riskCase);
  });
}

export async function acknowledgeCase(store: Store, auth: AuthenticatedUser, caseId: string): Promise<PublicCaseAcknowledgement> {
  requirePermission(auth.user, 'case:ack');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.assignedTo !== auth.user.id && auth.user.role !== 'professional_lead') throw forbidden();
    if (!['assigned', 'confirmed'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案当前不可接单');
    const existing = state.acknowledgements.find((ack) => ack.tenantId === auth.user.tenantId && ack.caseId === caseId && ack.userId === auth.user.id);
    if (existing) return publicCaseAcknowledgement(existing);
    const acknowledgement: CaseAcknowledgement = { id: id(), tenantId: auth.user.tenantId, caseId, userId: auth.user.id, acknowledgedAt: now() }; state.acknowledgements.push(acknowledgement);
    riskCase.state = 'in_support'; riskCase.updatedAt = now(); audit(state, auth.user, 'risk.case_acknowledged', 'risk_case', caseId, {}); return publicCaseAcknowledgement(acknowledgement);
  });
}

export async function addFollowUp(store: Store, auth: AuthenticatedUser, caseId: string, input: { kind: FollowUp['kind']; note: string; dueAt?: string }): Promise<PublicFollowUp> {
  requirePermission(auth.user, 'care:write');
  if (!['support', 'referral', 'follow_up'].includes(input.kind) || typeof input.note !== 'string' || !input.note.trim() || (input.dueAt !== undefined && !validDate(input.dueAt))) throw new DomainError('FOLLOW_UP_INVALID', '随访类型、说明或日期无效');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.assignedTo && riskCase.assignedTo !== auth.user.id && auth.user.role !== 'professional_lead') throw forbidden();
    if (!['in_support', 'follow_up'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案尚未接单');
    const followUp: FollowUp = { id: id(), tenantId: auth.user.tenantId, caseId, authorId: auth.user.id, kind: input.kind, noteCiphertext: encrypt({ note: input.note.slice(0, 4000) }), dueAt: input.dueAt, createdAt: now() }; state.followUps.push(followUp); riskCase.state = 'follow_up'; riskCase.updatedAt = now(); audit(state, auth.user, 'care.follow_up_added', 'risk_case', caseId, { kind: input.kind }); return publicFollowUp(followUp);
  });
}

export async function requestClosure(store: Store, auth: AuthenticatedUser, caseId: string, reason: string): Promise<PublicRiskCase> {
  requirePermission(auth.user, 'care:write');
  if (typeof reason !== 'string' || !reason.trim()) throw new DomainError('CLOSURE_REASON_REQUIRED', '申请结案需要记录依据');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.assignedTo && riskCase.assignedTo !== auth.user.id && auth.user.role !== 'professional_lead') throw forbidden();
    if (!['follow_up', 'in_support'].includes(riskCase.state)) throw new DomainError('CASE_STATE_INVALID', '个案当前不能申请结案');
    riskCase.state = 'closure_requested'; riskCase.closureRequestedBy = auth.user.id; riskCase.closureReasonCiphertext = encrypt({ reason: reason.slice(0, 4000) }); riskCase.updatedAt = now(); audit(state, auth.user, 'risk.closure_requested', 'risk_case', caseId, {}); return publicRiskCase(riskCase);
  });
}

export async function approveClosure(store: Store, auth: AuthenticatedUser, caseId: string): Promise<PublicRiskCase> {
  requirePermission(auth.user, 'case:review');
  return store.transaction((state) => {
    const riskCase = caseFor(state, auth, caseId);
    if (riskCase.state !== 'closure_requested') throw new DomainError('CASE_STATE_INVALID', '个案尚未申请结案');
    if (auth.user.role === 'counselor' && riskCase.assignedTo !== auth.user.id) throw forbidden();
    const requester = riskCase.closureRequestedBy;
    // Legacy snapshots may not have the requester marker.  Fail closed for
    // non-lead roles rather than inferring the actor from an arbitrary note.
    if (requester === auth.user.id || (auth.user.role !== 'professional_lead' && !requester)) throw new DomainError('SEPARATION_OF_DUTIES_REQUIRED', '结案审批需要独立专业复核', 403);
    riskCase.state = 'closed'; riskCase.updatedAt = now(); audit(state, auth.user, 'risk.case_closed', 'risk_case', caseId, {}); return publicRiskCase(riskCase);
  });
}

export async function adminOverview(store: Store, auth: AuthenticatedUser): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'analytics:read');
  return store.transaction((state) => {
    const tenant = auth.user.tenantId;
    const visibleStudents = state.students.filter((student) => sameTenant(student, tenant) && student.active && (!auth.user.schoolId || student.schoolId === auth.user.schoolId));
    const studentIds = new Set(visibleStudents.map((student) => student.id));
    const assignments = state.assignments.filter((assignment) => sameTenant(assignment, tenant) && studentIds.has(assignment.studentId));
    const reports = state.reports.filter((report) => sameTenant(report, tenant) && studentIds.has(report.studentId));
    const cases = state.riskCases.filter((riskCase) => sameTenant(riskCase, tenant) && studentIds.has(riskCase.studentId) && riskCase.state !== 'closed' && riskCase.state !== 'dismissed');
    const suppress = (value: number, size = visibleStudents.length): number | null => size < 10 ? null : value;
    const result = { students: visibleStudents.length, assignments: assignments.length, completedAssignments: assignments.filter((a) => a.status === 'completed').length, releasedReports: reports.filter((r) => r.state === 'released').length, openCases: suppress(cases.length), suppressionThreshold: 10, note: '小样本指标以 null 抑制；统计不代表疾病患病率。' };
    audit(state, auth.user, 'analytics.admin_overview_viewed', 'analytics', 'overview', { studentCount: visibleStudents.length });
    return result;
  });
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const source = text.replace(/^\uFEFF/, '');
  if (Buffer.byteLength(source, 'utf8') > 2_000_000) throw new DomainError('IMPORT_INVALID', 'CSV 文件大小超出限制');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      if (cell.length > 20_000) throw new DomainError('IMPORT_INVALID', 'CSV 单元格过大');
      continue;
    }
    if (char === '"' && cell.length === 0) { quoted = true; continue; }
    if (char === ',') { row.push(cell.trim()); cell = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell.trim()); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      if (rows.length > 10_001) throw new DomainError('IMPORT_INVALID', 'CSV 行数超出限制');
      row = [];
      continue;
    }
    cell += char;
    if (cell.length > 20_000) throw new DomainError('IMPORT_INVALID', 'CSV 单元格过大');
  }
  if (quoted) throw new DomainError('IMPORT_INVALID', 'CSV 引号未闭合');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value !== '')) rows.push(row);
  }
  if (rows.length < 2) throw new DomainError('IMPORT_INVALID', 'CSV 至少需要表头和一行数据');
  const headers = rows[0]!.map((header) => header.trim());
  if (headers.length === 0 || headers.length > 100 || headers.some((header) => !header) || new Set(headers).size !== headers.length || rows.slice(1).some((values) => values.length > headers.length)) throw new DomainError('IMPORT_INVALID', 'CSV 表头无效或数据列超出范围');
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export async function createRightsRequest(store: Store, auth: AuthenticatedUser, input: { studentId: string; kind: RightsRequest['kind']; reason?: string }): Promise<PublicRightsRequest> {
  if (!isStudent(auth.user) && !can(auth.user, 'rights:request')) throw forbidden();
  if (!['access', 'correct', 'delete', 'withdraw'].includes(input.kind)) throw new DomainError('RIGHTS_REQUEST_INVALID', '权利请求类型无效');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 1000 || /[\0\r\n]/.test(input.reason))) throw new DomainError('RIGHTS_REQUEST_INVALID', '权利请求说明格式无效');
  return store.transaction((state) => {
    const student = studentFor(state, auth.user, input.studentId);
    if (auth.user.role === 'guardian' && !state.guardianLinks.some((link) => link.tenantId === auth.user.tenantId && link.studentId === student.id && link.guardianUserId === auth.user.id && link.status === 'verified')) throw forbidden('监护人权利请求需要已核验监护关系');
    const reason = input.reason?.trim();
    const request: RightsRequest = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, kind: input.kind, requesterId: auth.user.id, status: 'open', reasonCiphertext: reason ? encrypt({ reason }) : undefined, createdAt: now() };
    state.rightsRequests.push(request);
    audit(state, auth.user, 'rights.requested', 'rights_request', request.id, { kind: request.kind });
    return publicRightsRequest(request);
  });
}

export async function listRightsRequests(store: Store, auth: AuthenticatedUser): Promise<PublicRightsRequest[]> {
  requirePermission(auth.user, 'rights:read');
  return store.transaction((state) => {
    const requests = state.rightsRequests.filter((request) => request.tenantId === auth.user.tenantId && (!auth.user.schoolId || state.students.some((student) => student.id === request.studentId && student.schoolId === auth.user.schoolId))).map(publicRightsRequest);
    audit(state, auth.user, 'rights.listed', 'rights_request', 'tenant', { count: requests.length }, 'rights:read');
    return requests;
  });
}

/** Return only the requests submitted by the authenticated student/guardian.
 * This avoids making the admin queue a de-facto subject-access endpoint while
 * still allowing a requester to track status and fetch a completed result. */
export async function listMyRightsRequests(store: Store, auth: AuthenticatedUser): Promise<PublicRightsRequest[]> {
  if (!isStudent(auth.user) && auth.user.role !== 'guardian') throw forbidden();
  return store.transaction((state) => {
    const requests = state.rightsRequests
      .filter((request) => request.tenantId === auth.user.tenantId && request.requesterId === auth.user.id)
      .map(publicRightsRequest);
    audit(state, auth.user, 'rights.own_listed', 'rights_request', 'self', { count: requests.length }, 'rights:request');
    return requests;
  });
}

function rightsAccessPackage(state: DatabaseState, request: RightsRequest): Record<string, unknown> {
  const student = state.students.find((candidate) => candidate.id === request.studentId && candidate.tenantId === request.tenantId);
  const reports = state.reports.filter((report) => report.tenantId === request.tenantId && report.studentId === request.studentId && report.state === 'released').map((report) => ({ id: report.id, title: report.title, createdAt: report.createdAt, releasedAt: report.releasedAt, summary: decrypt(report.summaryCiphertext), limitations: decrypt(report.limitationsCiphertext) }));
  return { requestId: request.id, studentId: request.studentId, basic: student ? { schoolId: student.schoolId, classId: student.classId, age: student.age } : undefined, reports, note: '这是经身份核验的查阅副本，不包含原始答卷或未发布专业记录。' };
}

export async function completeRightsRequest(store: Store, auth: AuthenticatedUser, requestId: string, decision: 'complete' | 'reject', decisionReason?: string): Promise<PublicRightsRequest> {
  requirePermission(auth.user, 'rights:manage');
  if (!['complete', 'reject'].includes(decision)) throw new DomainError('RIGHTS_DECISION_INVALID', '权利请求决定无效');
  if (decisionReason !== undefined && (typeof decisionReason !== 'string' || !decisionReason.trim() || decisionReason.length > 2000 || /[\0\r\n]/.test(decisionReason))) throw new DomainError('RIGHTS_DECISION_REASON_INVALID', '处理说明格式无效');
  if (decision === 'reject' && !decisionReason?.trim()) throw new DomainError('RIGHTS_DECISION_REASON_REQUIRED', '拒绝权利请求需要记录理由');
  return store.transaction((state) => {
    const request = state.rightsRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    if (!request) throw notFound();
    const requestStudent = state.students.find((candidate) => candidate.id === request.studentId && candidate.tenantId === request.tenantId);
    if (auth.user.schoolId && (!requestStudent || requestStudent.schoolId !== auth.user.schoolId)) throw notFound();
    if (!['open', 'processing'].includes(request.status)) throw new DomainError('RIGHTS_REQUEST_STATE_INVALID', '权利请求已处理');
    request.status = decision === 'complete' ? 'completed' : 'rejected'; request.completedAt = now();
    request.decisionReasonCiphertext = decisionReason?.trim() ? encrypt({ reason: decisionReason.trim().slice(0, 2000) }) : undefined;
    if (decision === 'reject') request.resultCiphertext = encrypt({ requestId: request.id, status: 'rejected', note: '该权利请求未获批准。', reason: decisionReason!.trim().slice(0, 2000) });
    if (decision === 'complete' && request.kind === 'access') request.resultCiphertext = encrypt(rightsAccessPackage(state, request));
    if (decision === 'complete' && request.kind === 'correct') request.resultCiphertext = encrypt({ requestId: request.id, status: 'completed', note: '更正申请已记录，请由校方隐私负责人完成身份和来源核验后更新。' });
    if (decision === 'complete' && request.kind === 'delete') {
      purgeStudentData(state, request.tenantId, request.studentId);
      const tombstone: DeletionTombstone = { id: id(), tenantId: auth.user.tenantId, studentId: request.studentId, requestId, deletedAt: now(), retainedCategories: ['minimal_audit_event', 'deletion_tombstone'] };
      state.deletionTombstones.push(tombstone);
      state.outboxEvents.push({ id: id(), tenantId: auth.user.tenantId, type: 'student.data_deleted', aggregateId: request.studentId, payload: { requestId }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
      request.resultCiphertext = encrypt({ requestId: request.id, status: 'completed', note: '删除申请已按核验流程处理。' });
    }
    if (decision === 'complete' && request.kind === 'withdraw') {
      for (const consent of state.consents.filter((candidate) => candidate.tenantId === auth.user.tenantId && candidate.studentId === request.studentId && candidate.purpose === 'assessment' && candidate.status === 'active')) { consent.status = 'withdrawn'; consent.withdrawnAt = now(); }
      revokeStudentAssessmentProcessing(state, auth.user.tenantId, request.studentId);
      audit(state, auth.user, 'rights.withdraw_applied', 'student', request.studentId, {});
      request.resultCiphertext = encrypt({ requestId: request.id, status: 'completed', note: '测评参与撤回已处理，后续测评处理已停止。' });
    }
    audit(state, auth.user, 'rights.completed', 'rights_request', request.id, { kind: request.kind, decision });
    return publicRightsRequest(request);
  });
}

export async function downloadRightsResult(store: Store, auth: AuthenticatedUser, requestId: string): Promise<Record<string, unknown>> {
  return store.transaction((state) => {
    const request = state.rightsRequests.find((candidate) => candidate.id === requestId && candidate.tenantId === auth.user.tenantId);
    const requestStudent = request ? state.students.find((candidate) => candidate.id === request.studentId && candidate.tenantId === request.tenantId) : undefined;
    if (!request || !['completed', 'rejected'].includes(request.status) || !request.resultCiphertext || (auth.user.schoolId && (!requestStudent || requestStudent.schoolId !== auth.user.schoolId)) || (request.requesterId !== auth.user.id && !can(auth.user, 'rights:read'))) throw forbidden();
    audit(state, auth.user, 'rights.result_downloaded', 'rights_request', request.id, { kind: request.kind }, 'rights:read');
    return decrypt<Record<string, unknown>>(request.resultCiphertext);
  });
}

/**
 * Run the reversible retention/restore jobs owned by operations.  Expired
 * exports are made unreadable and deletion tombstones are replayed against a
 * restored snapshot before service traffic is reopened.
 */
export async function processRetention(store: Store, auth: AuthenticatedUser, asOf = now()): Promise<Record<string, number>> {
  requirePermission(auth.user, 'system:metrics');
  if (!validDate(asOf)) throw new DomainError('RETENTION_DATE_INVALID', '保留任务时间无效');
  return store.transaction((state) => {
    const importCutoff = new Date(new Date(asOf).getTime() - 24 * 60 * 60_000);
    const expiredImportBatchIds = new Set(state.importBatches.filter((batch) => batch.status === 'previewed' && validDate(batch.createdAt) && new Date(batch.createdAt) <= importCutoff).map((batch) => batch.id));
    if (expiredImportBatchIds.size > 0) {
      state.importBatches = state.importBatches.filter((batch) => !expiredImportBatchIds.has(batch.id));
      state.importRows = state.importRows.filter((row) => !expiredImportBatchIds.has(row.batchId));
    }
    let expiredExports = 0;
    for (const job of state.exportJobs) {
      if (['requested', 'approved', 'ready'].includes(job.status) && validDate(job.expiresAt) && new Date(job.expiresAt) <= new Date(asOf)) {
        job.status = 'expired';
        job.payloadCiphertext = undefined;
        expiredExports += 1;
      }
    }
    let replayedDeletions = 0;
    for (const tombstone of state.deletionTombstones) {
      const hadRecoverableData = state.students.some((student) => student.tenantId === tombstone.tenantId && student.id === tombstone.studentId && student.active)
        || state.attempts.some((attempt) => attempt.tenantId === tombstone.tenantId && attempt.studentId === tombstone.studentId)
        || state.submissions.some((submission) => submission.tenantId === tombstone.tenantId && state.attempts.some((attempt) => attempt.tenantId === tombstone.tenantId && attempt.id === submission.attemptId && attempt.studentId === tombstone.studentId))
        || state.reports.some((report) => report.tenantId === tombstone.tenantId && report.studentId === tombstone.studentId)
        || state.riskCases.some((riskCase) => riskCase.tenantId === tombstone.tenantId && riskCase.studentId === tombstone.studentId)
        || state.exportJobs.some((job) => job.tenantId === tombstone.tenantId && job.studentId === tombstone.studentId && Boolean(job.payloadCiphertext));
      purgeStudentData(state, tombstone.tenantId, tombstone.studentId);
      const alreadyEmitted = state.outboxEvents.some((event) => event.tenantId === tombstone.tenantId && event.type === 'student.data_deleted' && event.aggregateId === tombstone.studentId && event.payload.requestId === tombstone.requestId);
      if (!alreadyEmitted) state.outboxEvents.push({ id: id(), tenantId: tombstone.tenantId, type: 'student.data_deleted', aggregateId: tombstone.studentId, payload: { requestId: tombstone.requestId }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
      if (hadRecoverableData || !alreadyEmitted) {
        audit(state, undefined, 'retention.deletion_replayed', 'deletion_tombstone', tombstone.id, { studentId: tombstone.studentId }, undefined, tombstone.tenantId);
        replayedDeletions += 1;
      }
    }
    if (expiredExports > 0) audit(state, auth.user, 'retention.exports_expired', 'export_job', 'batch', { count: expiredExports });
    return { expiredExports, expiredImportPreviews: expiredImportBatchIds.size, replayedDeletions };
  });
}

export async function operationalStatus(store: Store, auth: AuthenticatedUser): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'system:metrics');
  return store.transaction((state) => {
    const pending = state.outboxEvents.filter((event) => event.status === 'pending');
    const deadLetters = state.outboxEvents.filter((event) => event.status === 'dead_letter');
    const urgentPending = pending.filter((event) => event.type === 'risk.triage' || event.type === 'risk.signal_created');
    const oldest = pending.map((event) => event.createdAt).sort()[0];
    const unacknowledgedCases = state.riskCases.filter((riskCase) => ['pending_review', 'confirmed', 'assigned'].includes(riskCase.state) && !state.acknowledgements.some((ack) => ack.tenantId === riskCase.tenantId && ack.caseId === riskCase.id));
    const result = { pendingOutbox: pending.length, pendingUrgent: urgentPending.length, deadLetters: deadLetters.length, failedDeliveries: state.deliveryAttempts.filter((attempt) => attempt.status === 'failed').length, unacknowledgedCases: unacknowledgedCases.length, oldestPendingAt: oldest ?? null, requiresManualIntervention: deadLetters.length > 0 || unacknowledgedCases.length > 0, note: '指标仅供运维接续，不包含学生姓名、答卷或风险正文。' };
    audit(state, auth.user, 'operations.status_viewed', 'operations', 'outbox', { pendingOutbox: result.pendingOutbox, pendingUrgent: result.pendingUrgent, deadLetters: result.deadLetters });
    return result;
  });
}

/**
 * Escalate unacknowledged cases using an explicitly supplied, approved policy
 * interval.  This creates a protected reminder only; it never changes a case
 * to closed or claims that a person has been reached.
 */
export async function escalateUnacknowledged(store: Store, auth: AuthenticatedUser, input: { asOf?: string; thresholdMinutes: number }): Promise<{ escalated: number }> {
  requirePermission(auth.user, 'system:metrics');
  const asOf = input.asOf ?? now();
  if (!validDate(asOf) || !Number.isInteger(input.thresholdMinutes) || input.thresholdMinutes < 1 || input.thresholdMinutes > 7 * 24 * 60) throw new DomainError('ESCALATION_POLICY_INVALID', '升级策略时间无效');
  return store.transaction((state) => {
    const cutoff = new Date(new Date(asOf).getTime() - input.thresholdMinutes * 60_000);
    let escalated = 0;
    for (const riskCase of state.riskCases.filter((candidate) => ['pending_review', 'confirmed', 'assigned'].includes(candidate.state) && validDate(candidate.updatedAt) && new Date(candidate.updatedAt) <= cutoff && !state.acknowledgements.some((ack) => ack.tenantId === candidate.tenantId && ack.caseId === candidate.id))) {
      const alreadyQueued = state.outboxEvents.some((event) => event.tenantId === riskCase.tenantId && event.type === 'risk.escalation' && event.aggregateId === riskCase.id && ['pending', 'published'].includes(event.status));
      if (alreadyQueued) continue;
      state.outboxEvents.push({ id: id(), tenantId: riskCase.tenantId, type: 'risk.escalation', aggregateId: riskCase.id, payload: { caseId: riskCase.id, reason: 'unacknowledged_timeout' }, status: 'pending', attempts: 0, availableAt: now(), createdAt: now() });
      audit(state, undefined, 'risk.escalation_queued', 'risk_case', riskCase.id, { thresholdMinutes: input.thresholdMinutes }, undefined, riskCase.tenantId);
      escalated += 1;
    }
    if (escalated > 0) audit(state, auth.user, 'operations.escalations_queued', 'risk_case', 'batch', { count: escalated, thresholdMinutes: input.thresholdMinutes });
    return { escalated };
  });
}

export async function requeueDeadLetters(store: Store, auth: AuthenticatedUser, limit = 50): Promise<{ requeued: number }> {
  requirePermission(auth.user, 'system:metrics');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new DomainError('REQUEUE_LIMIT_INVALID', '补投数量必须在 1–500 之间');
  return store.transaction((state) => {
    const deadLetters = state.outboxEvents.filter((event) => event.status === 'dead_letter').slice(0, limit);
    for (const event of deadLetters) { event.status = 'pending'; event.attempts = 0; event.availableAt = now(); }
    if (deadLetters.length > 0) audit(state, auth.user, 'operations.dead_letters_requeued', 'outbox', 'batch', { count: deadLetters.length });
    return { requeued: deadLetters.length };
  });
}

function aggregatePayload(state: DatabaseState, tenantId: string, schoolId?: string): Record<string, unknown> {
  const students = state.students.filter((student) => student.tenantId === tenantId && student.active && (!schoolId || student.schoolId === schoolId));
  const studentIds = new Set(students.map((student) => student.id));
  const assignments = state.assignments.filter((assignment) => assignment.tenantId === tenantId && studentIds.has(assignment.studentId));
  const cases = state.riskCases.filter((riskCase) => riskCase.tenantId === tenantId && studentIds.has(riskCase.studentId) && !['closed', 'dismissed'].includes(riskCase.state));
  const suppress = (value: number, size = students.length): number | null => size < 10 ? null : value;
  return { studentCount: students.length, assignmentCount: assignments.length, completedCount: assignments.filter((assignment) => assignment.status === 'completed').length, openCaseCount: suppress(cases.length), suppressionThreshold: 10, generatedAt: now() };
}

export async function requestExport(store: Store, auth: AuthenticatedUser, input: { kind: ExportJob['kind']; studentId?: string; purpose?: string }): Promise<ExportJob> {
  requirePermission(auth.user, 'export:request');
  if (!['aggregate', 'report'].includes(input.kind)) throw new DomainError('EXPORT_KIND_INVALID', '导出类型无效');
  if (input.kind === 'report' && !isProfessional(auth.user)) throw forbidden();
  const defaultPurpose = input.kind === 'aggregate' ? 'approved_aggregate_reporting' : 'approved_professional_report';
  if (input.purpose !== undefined && typeof input.purpose !== 'string') throw new DomainError('EXPORT_PURPOSE_INVALID', '导出用途必须是有限、可审计的说明');
  const purpose = input.purpose === undefined ? defaultPurpose : input.purpose.trim();
  if (!purpose || purpose.length > 120 || /[\0\r\n]/.test(purpose)) throw new DomainError('EXPORT_PURPOSE_INVALID', '导出用途必须是有限、可审计的说明');
  return store.transaction((state) => {
    if (input.studentId) {
      const student = state.students.find((candidate) => candidate.id === input.studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
      if (!student) throw notFound();
      if (auth.user.schoolId && student.schoolId !== auth.user.schoolId) throw forbidden();
      if (input.kind === 'report' && !professionalCanReadStudent(state, auth, student.id)) throw notFound();
    }
    if (input.kind === 'report' && !input.studentId) throw new DomainError('EXPORT_SCOPE_REQUIRED', '报告导出需要明确学生范围');
    const job: ExportJob = { id: id(), tenantId: auth.user.tenantId, requestedBy: auth.user.id, purpose, kind: input.kind, studentId: input.studentId, status: 'requested', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), createdAt: now() };
    state.exportJobs.push(job); audit(state, auth.user, 'export.requested', 'export_job', job.id, { kind: job.kind, purpose }); return job;
  });
}

export async function approveExport(store: Store, auth: AuthenticatedUser, jobId: string): Promise<PublicExportJob> {
  requirePermission(auth.user, 'export:approve');
  const preflight = await store.read((state) => {
    const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
    return { exists: Boolean(job), expired: Boolean(job && job.status === 'requested' && validDate(job.expiresAt) && new Date(job.expiresAt) <= new Date()) };
  });
  if (!preflight.exists) throw notFound();
  if (preflight.expired) {
    await store.transaction((state) => {
      const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
      if (job && job.status === 'requested' && validDate(job.expiresAt) && new Date(job.expiresAt) <= new Date()) {
        job.status = 'expired';
        audit(state, auth.user, 'export.expired', 'export_job', job.id, { kind: job.kind });
      }
    });
    throw new DomainError('EXPORT_EXPIRED', '导出请求已过期', 410);
  }
  try {
    return await store.transaction((state) => {
      const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
      if (!job) throw notFound();
      if (job.status !== 'requested') throw new DomainError('EXPORT_STATE_INVALID', '导出任务当前不可审批');
      if (job.requestedBy === auth.user.id) throw new DomainError('SEPARATION_OF_DUTIES_REQUIRED', '导出审批需要独立审批人', 403);
      if (new Date(job.expiresAt) <= new Date()) throw new DomainError('EXPORT_EXPIRED', '导出请求已过期', 410);
      let payload: unknown;
      const issuedAt = now();
      const watermark = { jobId: job.id, purpose: job.purpose ?? 'legacy', requestedBy: job.requestedBy, approvedBy: auth.user.id, issuedAt };
      if (job.kind === 'aggregate') payload = { ...aggregatePayload(state, auth.user.tenantId, auth.user.schoolId), watermark };
      else {
        if (!job.studentId) throw new DomainError('EXPORT_SCOPE_REQUIRED', '报告导出需要明确学生范围');
        if (!isProfessional(auth.user) || !professionalCanReadStudent(state, auth, job.studentId)) throw forbidden();
        const report = state.reports.find((candidate) => candidate.studentId === job.studentId && candidate.tenantId === auth.user.tenantId && candidate.state === 'released');
        if (!report) throw new DomainError('REPORT_NOT_RELEASED', '只有已发布报告可导出');
        payload = { reportId: report.id, studentId: report.studentId, title: report.title, summary: decrypt(report.summaryCiphertext), exportedAt: issuedAt, watermark, note: '导出内容来自已发布报告，不包含原始答卷。' };
      }
      job.approvedBy = auth.user.id; job.approvedAt = now(); job.status = 'ready'; job.payloadCiphertext = encrypt(payload); audit(state, auth.user, 'export.approved', 'export_job', job.id, { kind: job.kind });
      const { payloadCiphertext: _payloadCiphertext, ...publicJob } = job;
      return { ...publicJob, ready: true };
    });
  } catch (error) {
    // A request can cross its expiry boundary after the read-only preflight.
    // Persist the terminal state in a separate transaction because the failed
    // approval transaction is rolled back by both reference and SQL stores.
    if (error instanceof DomainError && error.code === 'EXPORT_EXPIRED') {
      await store.transaction((state) => {
        const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
        if (job && job.status === 'requested' && validDate(job.expiresAt) && new Date(job.expiresAt) <= new Date()) {
          job.status = 'expired';
          audit(state, auth.user, 'export.expired', 'export_job', job.id, { kind: job.kind });
        }
      });
    }
    throw error;
  }
}

export async function downloadExport(store: Store, auth: AuthenticatedUser, jobId: string): Promise<Record<string, unknown>> {
  // Perform a read-only preflight so a revoked report can be invalidated in a
  // separate committed transaction before returning the error. JsonStore (and
  // PostgreSQL) roll back all mutations made in a transaction that throws.
  const preflight = await store.read((state) => {
    const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
    const isRequester = job?.requestedBy === auth.user.id && can(auth.user, 'export:request');
    if (!job || (!isRequester && !can(auth.user, 'export:approve'))) return { allowed: false, revoke: false, expire: false };
    const revoke = job.kind === 'report' && job.status === 'ready' && Boolean(job.payloadCiphertext) && (!job.studentId || !state.reports.some((report) => report.tenantId === job.tenantId && report.studentId === job.studentId && report.state === 'released'));
    const expire = job.status === 'ready' && Boolean(job.payloadCiphertext) && validDate(job.expiresAt) && new Date(job.expiresAt) <= new Date();
    return { allowed: true, revoke, expire };
  });
  if (!preflight.allowed) throw forbidden();
  if (preflight.revoke) {
    await store.transaction((state) => {
      const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
      if (job && job.status === 'ready') {
        job.status = 'revoked';
        job.payloadCiphertext = undefined;
        audit(state, auth.user, 'export.revoked', 'export_job', job.id, { kind: job.kind });
      }
    });
    throw new DomainError('EXPORT_REVOKED', '关联报告已撤回，导出已失效', 410);
  }
  if (preflight.expire) {
    await store.transaction((state) => {
      const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
      if (job && job.status === 'ready' && job.payloadCiphertext && validDate(job.expiresAt) && new Date(job.expiresAt) <= new Date()) {
        job.status = 'expired';
        job.payloadCiphertext = undefined;
        audit(state, auth.user, 'export.expired', 'export_job', job.id, { kind: job.kind });
      }
    });
    throw new DomainError('EXPORT_EXPIRED', '导出已过期', 410);
  }
  try {
    return await store.transaction((state) => {
      const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
      const isRequester = job?.requestedBy === auth.user.id && can(auth.user, 'export:request');
      if (!job || (!isRequester && !can(auth.user, 'export:approve'))) throw forbidden();
      if (job.kind === 'report' && (!isProfessional(auth.user) || !job.studentId || !professionalCanReadStudent(state, auth, job.studentId))) throw forbidden();
      if (job.status !== 'ready' || !job.payloadCiphertext) throw new DomainError('EXPORT_NOT_READY', '导出尚未准备好');
      if (new Date(job.expiresAt) <= new Date()) throw new DomainError('EXPORT_EXPIRED', '导出已过期', 410);
      if (job.kind === 'report' && (!job.studentId || !state.reports.some((report) => report.tenantId === job.tenantId && report.studentId === job.studentId && report.state === 'released'))) throw new DomainError('EXPORT_REVOKED', '关联报告已撤回，导出已失效', 410);
      audit(state, auth.user, 'export.downloaded', 'export_job', job.id, { kind: job.kind });
      return decrypt<Record<string, unknown>>(job.payloadCiphertext);
    });
  } catch (error) {
    // Close a narrow race where a report was revoked after the preflight read.
    if (error instanceof DomainError && ['EXPORT_REVOKED', 'EXPORT_EXPIRED'].includes(error.code)) {
      await store.transaction((state) => {
        const job = state.exportJobs.find((candidate) => candidate.id === jobId && candidate.tenantId === auth.user.tenantId);
        if (job && job.status === 'ready' && job.payloadCiphertext) {
          job.status = error.code === 'EXPORT_REVOKED' ? 'revoked' : 'expired';
          job.payloadCiphertext = undefined;
          audit(state, auth.user, error.code === 'EXPORT_REVOKED' ? 'export.revoked' : 'export.expired', 'export_job', job.id, { kind: job.kind });
        }
      });
    }
    throw error;
  }
}

export async function getAnalytics(store: Store, auth: AuthenticatedUser, groupBy: string): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'analytics:read');
  const allowed = new Set(['school', 'age_band', 'academic_year']);
  if (!allowed.has(groupBy)) throw new DomainError('ANALYTICS_DIMENSION_INVALID', '该统计维度未获批准');
  return store.transaction((state) => {
    const tenantStudents = state.students.filter((student) => student.tenantId === auth.user.tenantId && student.active && (!auth.user.schoolId || student.schoolId === auth.user.schoolId));
    const groups = new Map<string, number>();
    if (groupBy === 'academic_year') {
      // Academic year is an attribute of a campaign/assignment, not of the
      // student directory. Count each student once per year so a duplicate
      // assignment or a re-run cannot inflate the aggregate.
      const studentIds = new Set(tenantStudents.map((student) => student.id));
      const byYear = new Map<string, Set<string>>();
      for (const assignment of state.assignments.filter((candidate) => candidate.tenantId === auth.user.tenantId && studentIds.has(candidate.studentId))) {
        const campaign = state.campaigns.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.id === assignment.campaignId);
        if (!campaign) continue;
        const members = byYear.get(campaign.academicYear) ?? new Set<string>();
        members.add(assignment.studentId);
        byYear.set(campaign.academicYear, members);
      }
      for (const [year, members] of byYear) groups.set(year, members.size);
    } else {
      for (const student of tenantStudents) {
        const key = groupBy === 'school' ? student.schoolId : (student.age === undefined ? 'unknown' : student.age < 14 ? '6-13' : '14-19');
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
    }
    const rows = [...groups.entries()].map(([key, count]) => ({ key, count: count < 10 ? null : count, suppressed: count < 10 }));
    audit(state, auth.user, 'analytics.viewed', 'analytics', groupBy, { groupCount: rows.length });
    return { groupBy, rows, suppressionThreshold: 10, note: '小样本与可重识别单元已抑制；指标不是疾病患病率。' };
  });
}

export async function createProfileSchema(store: Store, auth: AuthenticatedUser, input: { version: string; fields: ProfileSchemaVersion['fields'] }): Promise<ProfileSchemaVersion> {
  requirePermission(auth.user, 'profile:write');
  if (typeof input.version !== 'string' || !input.version.trim() || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > 50) throw new DomainError('PROFILE_SCHEMA_INVALID', '字段数量或版本无效');
  if (input.fields.some((field) => !field || typeof field.id !== 'string' || !field.id.trim() || typeof field.label !== 'string' || !field.label.trim() || typeof field.purpose !== 'string' || !field.purpose.trim() || typeof field.required !== 'boolean' || typeof field.sensitive !== 'boolean')) throw new DomainError('PROFILE_SCHEMA_INVALID', '字段必须包含目的、标签和布尔属性');
  if (new Set(input.fields.map((field) => field.id)).size !== input.fields.length) throw new DomainError('PROFILE_SCHEMA_INVALID', '调查字段标识不能重复');
  return store.transaction((state) => {
    if (state.profileSchemas.some((candidate) => candidate.tenantId === auth.user.tenantId && candidate.version === input.version)) throw new DomainError('PROFILE_SCHEMA_VERSION_EXISTS', '同一调查版本已经存在', 409);
    const schema: ProfileSchemaVersion = { id: id(), tenantId: auth.user.tenantId, version: input.version, fields: input.fields, state: 'draft', createdAt: now() }; state.profileSchemas.push(schema); audit(state, auth.user, 'profile_schema.created', 'profile_schema', schema.id, { fieldCount: input.fields.length }); return schema;
  });
}

export async function approveProfileSchema(store: Store, auth: AuthenticatedUser, schemaId: string): Promise<ProfileSchemaVersion> {
  requirePermission(auth.user, 'profile:approve');
  return store.transaction((state) => {
    const schema = state.profileSchemas.find((candidate) => candidate.id === schemaId && candidate.tenantId === auth.user.tenantId);
    if (!schema) throw notFound();
    schema.state = 'approved'; schema.approvedBy = auth.user.id; audit(state, auth.user, 'profile_schema.approved', 'profile_schema', schema.id, {}); return schema;
  });
}

export async function createAvailabilitySlot(store: Store, auth: AuthenticatedUser, input: { counselorId: string; startsAt: string; endsAt: string; room?: string }): Promise<AvailabilitySlot> {
  requirePermission(auth.user, 'appointment:manage');
  if (input.room !== undefined && typeof input.room !== 'string') throw new DomainError('SLOT_INVALID', '排班备注格式无效');
  const room = input.room?.trim().slice(0, 100);
  return store.transaction((state) => {
    const counselor = state.users.find((candidate) => candidate.id === input.counselorId && candidate.tenantId === auth.user.tenantId && isProfessional(candidate));
    if (!counselor || (auth.user.schoolId && auth.user.schoolId !== counselor.schoolId) || !validDate(input.startsAt) || !validDate(input.endsAt) || new Date(input.startsAt) >= new Date(input.endsAt)) throw new DomainError('SLOT_INVALID', '排班人员或时间窗无效');
    const overlap = state.availabilitySlots.some((slot) => slot.tenantId === auth.user.tenantId && slot.status !== 'blocked' && new Date(input.startsAt) < new Date(slot.endsAt) && new Date(input.endsAt) > new Date(slot.startsAt) && (slot.counselorId === counselor.id || (Boolean(room) && Boolean(slot.room?.trim()) && slot.room?.trim() === room)));
    if (overlap) throw new DomainError('SLOT_CONFLICT', '咨询师或咨询室时间段重叠', 409);
    const slot: AvailabilitySlot = { id: id(), tenantId: auth.user.tenantId, counselorId: counselor.id, startsAt: input.startsAt, endsAt: input.endsAt, room, status: 'available' }; state.availabilitySlots.push(slot); audit(state, auth.user, 'availability.created', 'availability_slot', slot.id, {}); return slot;
  });
}

export async function requestAppointment(store: Store, auth: AuthenticatedUser, input: { slotId: string; note?: string; idempotencyKey?: string }): Promise<Appointment> {
  requirePermission(auth.user, 'self:appointment');
  if (!isStudent(auth.user)) throw forbidden();
  if (input.note !== undefined && typeof input.note !== 'string') throw new DomainError('APPOINTMENT_INVALID', '预约说明格式无效');
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 128 || /[\r\n]/.test(idempotencyKey))) throw new DomainError('APPOINTMENT_IDEMPOTENCY_INVALID', '预约幂等键格式无效');
  const idempotencyHash = idempotencyKey ? contentHash({ slotId: input.slotId, note: input.note ?? null }) : undefined;
  return store.transaction((state) => {
    if (idempotencyKey) {
      const previous = state.appointments.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.studentId === auth.user.id && candidate.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.idempotencyHash !== idempotencyHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同预约内容', 409);
        return previous;
      }
    }
    const slot = state.availabilitySlots.find((candidate) => candidate.id === input.slotId && candidate.tenantId === auth.user.tenantId && candidate.status === 'available');
    const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
    if (!slot || !student || (auth.user.schoolId && student.schoolId !== auth.user.schoolId) || new Date(slot.startsAt) <= new Date()) throw new DomainError('SLOT_UNAVAILABLE', '该时段不可预约', 409);
    if (state.appointments.some((appointment) => appointment.tenantId === auth.user.tenantId && appointment.slotId === slot.id && ['requested', 'confirmed'].includes(appointment.state))) throw new DomainError('SLOT_UNAVAILABLE', '该时段刚刚被预约', 409);
    const appointment: Appointment = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, counselorId: slot.counselorId, slotId: slot.id, state: 'requested', noteCiphertext: input.note ? encrypt({ note: input.note.slice(0, 1000) }) : undefined, ...(idempotencyKey ? { idempotencyKey, idempotencyHash } : {}), createdAt: now(), updatedAt: now() }; state.appointments.push(appointment); slot.status = 'held'; audit(state, auth.user, 'appointment.requested', 'appointment', appointment.id, {}); return appointment;
  });
}

export async function updateAppointment(store: Store, auth: AuthenticatedUser, appointmentId: string, stateValue: AppointmentState): Promise<Appointment> {
  if (!isStudent(auth.user) && !can(auth.user, 'appointment:manage')) throw forbidden();
  if (!['requested', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(stateValue)) throw new DomainError('APPOINTMENT_STATE_INVALID', '预约状态无效');
  return store.transaction((state) => {
    const appointment = state.appointments.find((candidate) => candidate.id === appointmentId && candidate.tenantId === auth.user.tenantId);
    if (!appointment) throw notFound();
    if (isStudent(auth.user) && appointment.studentId !== auth.user.id) throw forbidden();
    const appointmentStudent = state.students.find((student) => student.tenantId === auth.user.tenantId && student.id === appointment.studentId);
    const appointmentCounselor = state.users.find((user) => user.tenantId === auth.user.tenantId && user.id === appointment.counselorId && isProfessional(user));
    if (auth.user.schoolId && (appointmentStudent?.schoolId !== auth.user.schoolId || appointmentCounselor?.schoolId !== auth.user.schoolId)) throw forbidden();
    if (isStudent(auth.user) && stateValue !== 'cancelled') throw forbidden();
    if (stateValue === 'confirmed' && !can(auth.user, 'appointment:manage')) throw forbidden();
    if (['completed', 'no_show'].includes(stateValue) && !can(auth.user, 'appointment:manage')) throw forbidden();
    const transitions: Record<AppointmentState, AppointmentState[]> = { requested: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled', 'no_show'], completed: [], cancelled: [], no_show: [] };
    if (!transitions[appointment.state].includes(stateValue)) throw new DomainError('APPOINTMENT_STATE_INVALID', '预约状态不能这样变更');
    appointment.state = stateValue; appointment.updatedAt = now();
    const slot = state.availabilitySlots.find((candidate) => candidate.id === appointment.slotId && candidate.tenantId === auth.user.tenantId);
    if (slot && ['cancelled', 'completed', 'no_show'].includes(stateValue)) slot.status = 'available';
    if (slot && stateValue === 'confirmed') slot.status = 'held';
    audit(state, auth.user, `appointment.${stateValue}`, 'appointment', appointment.id, {}); return appointment;
  });
}

type PublicAvailabilitySlot = {
  id: string;
  startsAt: string;
  endsAt: string;
  room?: string;
  counselorName: string;
  status: AvailabilitySlot['status'];
};

/**
 * Return future appointment windows without exposing internal staff records or
 * any student notes. Students only receive genuinely available slots; staff
 * with appointment management permission receive the scoped operational view.
 */
export async function listAvailabilitySlots(store: Store, auth: AuthenticatedUser): Promise<PublicAvailabilitySlot[]> {
  if (!isStudent(auth.user) && !can(auth.user, 'appointment:manage')) throw forbidden();
  return store.transaction((state) => {
    const currentTime = new Date();
    const slots = state.availabilitySlots
      .filter((slot) => slot.tenantId === auth.user.tenantId && validDate(slot.startsAt) && validDate(slot.endsAt) && new Date(slot.startsAt) > currentTime && new Date(slot.endsAt) > currentTime && (!auth.user.schoolId || state.users.find((user) => user.id === slot.counselorId && user.tenantId === auth.user.tenantId)?.schoolId === auth.user.schoolId))
      .filter((slot) => isStudent(auth.user) ? slot.status === 'available' : true)
      .map((slot) => {
        const counselor = state.users.find((user) => user.id === slot.counselorId && user.tenantId === auth.user.tenantId && isProfessional(user));
        return { id: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, ...(slot.room ? { room: slot.room } : {}), counselorName: counselor?.displayName ?? '心理支持人员', status: slot.status };
      });
    audit(state, auth.user, 'availability.listed', 'availability_slot', isStudent(auth.user) ? 'self' : 'school', { count: slots.length }, 'appointment:read');
    return slots;
  });
}

type PublicAppointment = {
  id: string;
  state: AppointmentState;
  startsAt?: string;
  endsAt?: string;
  room?: string;
  counselorName: string;
  createdAt: string;
  updatedAt: string;
  studentId?: string;
};

/**
 * List appointment status and time metadata. Notes stay encrypted and are not
 * returned by a list endpoint; a future counselor detail view must authorize
 * a purpose before decrypting them.
 */
export async function listAppointments(store: Store, auth: AuthenticatedUser): Promise<PublicAppointment[]> {
  if (!isStudent(auth.user) && !can(auth.user, 'appointment:manage')) throw forbidden();
  return store.transaction((state) => {
    const appointments = state.appointments
      .filter((appointment) => appointment.tenantId === auth.user.tenantId && (isStudent(auth.user) ? appointment.studentId === auth.user.id : true))
      .filter((appointment) => {
        const student = state.students.find((candidate) => candidate.id === appointment.studentId && candidate.tenantId === auth.user.tenantId);
        const counselor = state.users.find((candidate) => candidate.id === appointment.counselorId && candidate.tenantId === auth.user.tenantId && isProfessional(candidate));
        return !auth.user.schoolId || (student?.schoolId === auth.user.schoolId && counselor?.schoolId === auth.user.schoolId);
      })
      .map((appointment) => {
        const slot = state.availabilitySlots.find((candidate) => candidate.id === appointment.slotId && candidate.tenantId === auth.user.tenantId);
        const counselor = state.users.find((user) => user.id === appointment.counselorId && user.tenantId === auth.user.tenantId && isProfessional(user));
        return { id: appointment.id, state: appointment.state, ...(slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt, ...(slot.room ? { room: slot.room } : {}) } : {}), counselorName: counselor?.displayName ?? '心理支持人员', createdAt: appointment.createdAt, updatedAt: appointment.updatedAt, ...(!isStudent(auth.user) ? { studentId: appointment.studentId } : {}) };
      });
    audit(state, auth.user, 'appointment.listed', 'appointment', isStudent(auth.user) ? 'self' : 'school', { count: appointments.length }, 'appointment:read');
    return appointments;
  });
}

/** Block or reopen an unheld slot while preserving any booked appointment. */
export async function updateAvailabilitySlot(store: Store, auth: AuthenticatedUser, slotId: string, status: 'available' | 'blocked'): Promise<AvailabilitySlot> {
  requirePermission(auth.user, 'appointment:manage');
  if (status !== 'available' && status !== 'blocked') throw new DomainError('SLOT_STATUS_INVALID', '排班状态无效');
  return store.transaction((state) => {
    const slot = state.availabilitySlots.find((candidate) => candidate.id === slotId && candidate.tenantId === auth.user.tenantId);
    const counselor = slot ? state.users.find((user) => user.id === slot.counselorId && user.tenantId === auth.user.tenantId && isProfessional(user)) : undefined;
    if (!slot || !counselor || (auth.user.schoolId && counselor.schoolId !== auth.user.schoolId)) throw notFound();
    if (slot.status === 'held') throw new DomainError('SLOT_HELD', '已有预约的时段不能直接改排班状态', 409);
    slot.status = status;
    audit(state, auth.user, `availability.${status}`, 'availability_slot', slot.id, {});
    return slot;
  });
}

const MAX_MEDIA_BYTES = 1_500_000;
const MEDIA_POLICIES: Record<string, { kind: MediaKind; signature: (buffer: Buffer) => boolean }> = {
  'image/png': { kind: 'image', signature: (buffer) => buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  'image/jpeg': { kind: 'image', signature: (buffer) => buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) },
  'image/webp': { kind: 'image', signature: (buffer) => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' },
  'audio/mpeg': { kind: 'audio', signature: (buffer) => buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) },
  'audio/ogg': { kind: 'audio', signature: (buffer) => buffer.subarray(0, 4).toString('ascii') === 'OggS' },
  'audio/wav': { kind: 'audio', signature: (buffer) => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE' },
  'video/mp4': { kind: 'video', signature: (buffer) => buffer.subarray(4, 8).toString('ascii') === 'ftyp' },
  'video/webm': { kind: 'video', signature: (buffer) => buffer.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) },
  'text/vtt': { kind: 'subtitle', signature: (buffer) => buffer.toString('utf8', 0, Math.min(buffer.length, 64)).trimStart().startsWith('WEBVTT') },
};

function decodeMedia(encoded: string): Buffer {
  if (!encoded || encoded.length > Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) throw new DomainError('MEDIA_INVALID', '媒体内容编码无效');
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) throw new DomainError('MEDIA_TOO_LARGE', '媒体文件大小超出限制', 413);
  return buffer;
}

export async function createMediaAsset(store: Store, auth: AuthenticatedUser, input: { filename: string; mediaType: string; base64: string }): Promise<MediaAsset> {
  requirePermission(auth.user, 'content:write');
  // The reference implementation performs bounded signature and content
  // heuristics below. Production uploads additionally require an approved
  // malware-scanning adapter; never mark a provider-less upload clean merely
  // because the local checks passed.
  if (process.env.NODE_ENV === 'production' && (process.env.CAMPMIND_MEDIA_SCANNER_READY !== 'true' || !store.mediaScanner)) throw new DomainError('MEDIA_SCANNER_NOT_CONFIGURED', '生产媒体上传尚未接入恶意文件扫描', 503);
  if (typeof input.filename !== 'string' || typeof input.mediaType !== 'string' || typeof input.base64 !== 'string') throw new DomainError('MEDIA_INVALID', '媒体字段格式无效');
  const policy = MEDIA_POLICIES[input.mediaType];
  if (!policy) throw new DomainError('MEDIA_TYPE_NOT_ALLOWED', '媒体类型未获批准');
  const filename = input.filename.trim().replace(/[\\/\0\r\n"]/g, '_').slice(0, 200);
  if (!filename) throw new DomainError('MEDIA_INVALID', '媒体文件名无效');
  const buffer = decodeMedia(input.base64);
  const textPrefix = buffer.subarray(0, Math.min(buffer.length, 1_000_000)).toString('utf8');
  if (buffer.subarray(0, 2).toString('ascii') === 'MZ' || /<\s*(script|iframe|object)\b/i.test(textPrefix)) throw new DomainError('MEDIA_SCAN_REJECTED', '媒体安全检查未通过');
  if (!policy.signature(buffer)) throw new DomainError('MEDIA_SIGNATURE_MISMATCH', '媒体类型与文件内容不匹配');
  if (store.mediaScanner) {
    let verdict: Awaited<ReturnType<NonNullable<Store['mediaScanner']>['scan']>>;
    try { verdict = await store.mediaScanner.scan({ tenantId: auth.user.tenantId, filename, mediaType: input.mediaType, bytes: buffer }); }
    catch { throw new DomainError('MEDIA_SCANNER_UNAVAILABLE', '媒体安全扫描暂时不可用，请稍后重试', 503); }
    if (!verdict || !['clean', 'rejected'].includes(verdict.status) || typeof verdict.provider !== 'string' || !verdict.provider.trim()) throw new DomainError('MEDIA_SCANNER_UNAVAILABLE', '媒体安全扫描返回无效结果', 503);
    if (verdict.status !== 'clean') throw new DomainError('MEDIA_SCAN_REJECTED', '媒体安全检查未通过');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const objectKey = store.objectStore ? `media/${auth.user.tenantId}/${sha256}` : undefined;
  let objectStored = false;
  try {
    return await store.transaction(async (state) => {
      if (state.mediaAssets.some((asset) => asset.tenantId === auth.user.tenantId && asset.sha256 === sha256)) throw new DomainError('MEDIA_DUPLICATE', '相同媒体资源已经存在', 409);
      if (objectKey) {
        await store.objectStore!.put({ tenantId: auth.user.tenantId, objectKey, contentType: input.mediaType, bytes: buffer });
        objectStored = true;
      }
      const asset: MediaAsset = { id: id(), tenantId: auth.user.tenantId, filename, mediaType: input.mediaType, kind: policy.kind, byteSize: buffer.length, sha256, contentCiphertext: objectKey ? encrypt({ objectKey }) : encrypt(buffer.toString('base64')), ...(objectKey ? { objectKey } : {}), scanStatus: 'clean', createdBy: auth.user.id, createdAt: now() };
      state.mediaAssets.push(asset);
      audit(state, auth.user, 'media.created', 'media_asset', asset.id, { mediaType: asset.mediaType, byteSize: asset.byteSize });
      return asset;
    });
  } catch (error) {
    // Avoid leaving an unreachable private object if the database transaction
    // or durable snapshot write fails after the object upload succeeded.
    if (objectStored && objectKey) await store.objectStore!.delete({ tenantId: auth.user.tenantId, objectKey }).catch(() => undefined);
    throw error;
  }
}

export async function readPublicMedia(store: Store, assetId: string): Promise<{ mediaType: string; filename: string; bytes: Buffer }> {
  const record = await store.read((state) => {
    const asset = state.mediaAssets.find((candidate) => candidate.id === assetId && candidate.scanStatus === 'clean');
    const linked = asset && state.contentItems.some((item) => item.mediaAssetId === asset.id && item.tenantId === asset.tenantId && item.state === 'published');
    if (!asset || !linked) throw notFound();
    return { asset };
  });
  let bytes: Buffer;
  if (record.asset.objectKey) {
    if (!store.objectStore) throw new DomainError('MEDIA_STORAGE_UNAVAILABLE', '媒体私有存储未配置', 503);
    let object;
    try { object = await store.objectStore.get({ tenantId: record.asset.tenantId, objectKey: record.asset.objectKey }); } catch { throw new DomainError('MEDIA_STORAGE_UNAVAILABLE', '媒体资源暂时不可用', 503); }
    if (object.contentType !== record.asset.mediaType || object.byteSize !== record.asset.byteSize || object.sha256 !== record.asset.sha256) throw new DomainError('MEDIA_STORAGE_CORRUPT', '媒体资源校验失败', 503);
    bytes = object.bytes;
  } else {
    bytes = Buffer.from(decrypt<string>(record.asset.contentCiphertext), 'base64');
  }
  return { mediaType: record.asset.mediaType, filename: record.asset.filename, bytes };
}

export async function createContent(store: Store, auth: AuthenticatedUser, input: { title: string; kind: ContentItem['kind']; body: string; ageMin: number; ageMax: number; copyrightSource: string; mediaAssetId?: string; altText?: string; captionText?: string }): Promise<ContentItem> {
  requirePermission(auth.user, 'content:write');
  if (!['article', 'announcement', 'media'].includes(input.kind) || typeof input.title !== 'string' || !input.title.trim() || typeof input.body !== 'string' || !input.body.trim() || typeof input.copyrightSource !== 'string' || !input.copyrightSource.trim() || !Number.isInteger(input.ageMin) || !Number.isInteger(input.ageMax) || input.ageMin < 6 || input.ageMax > 19 || input.ageMin > input.ageMax) throw new DomainError('CONTENT_INVALID', '内容、版权、类型或适龄范围无效');
  if ((input.mediaAssetId !== undefined && typeof input.mediaAssetId !== 'string') || (input.altText !== undefined && typeof input.altText !== 'string') || (input.captionText !== undefined && typeof input.captionText !== 'string')) throw new DomainError('CONTENT_INVALID', '媒体引用或无障碍说明格式无效');
  if (input.kind === 'media' && !input.mediaAssetId) throw new DomainError('MEDIA_REQUIRED', '媒体内容需要绑定已检查的媒体资源');
  if (input.kind !== 'media' && input.mediaAssetId) throw new DomainError('CONTENT_INVALID', '非媒体内容不能绑定媒体资源');
  if (input.kind === 'media' && input.altText === undefined && input.captionText === undefined) throw new DomainError('ACCESSIBILITY_TEXT_REQUIRED', '媒体内容需要文字替代或字幕说明');
  return store.transaction((state) => {
    const media = input.mediaAssetId ? state.mediaAssets.find((asset) => asset.id === input.mediaAssetId && asset.tenantId === auth.user.tenantId && asset.scanStatus === 'clean') : undefined;
    if (input.mediaAssetId && !media) throw notFound();
    const item: ContentItem = { id: id(), tenantId: auth.user.tenantId, title: input.title.trim().slice(0, 200), kind: input.kind, ageMin: input.ageMin, ageMax: input.ageMax, bodyCiphertext: encrypt({ body: input.body.slice(0, 30_000) }), state: 'draft', copyrightSource: input.copyrightSource.slice(0, 500), createdBy: auth.user.id, mediaAssetId: media?.id, altText: input.altText?.trim().slice(0, 2000), captionText: input.captionText?.trim().slice(0, 20_000), createdAt: now() }; state.contentItems.push(item); audit(state, auth.user, 'content.created', 'content', item.id, { kind: item.kind, mediaAssetId: media?.id ?? null }); return item;
  });
}

export async function approveContent(store: Store, auth: AuthenticatedUser, contentId: string): Promise<ContentItem> {
  requirePermission(auth.user, 'content:approve');
  return store.transaction((state) => { const item = state.contentItems.find((candidate) => candidate.id === contentId && candidate.tenantId === auth.user.tenantId); if (!item) throw notFound(); if (item.state !== 'draft' && item.state !== 'professional_review') throw new DomainError('CONTENT_STATE_INVALID', '内容当前不可审核'); if (item.kind === 'media') { const media = item.mediaAssetId ? state.mediaAssets.find((asset) => asset.id === item.mediaAssetId && asset.tenantId === item.tenantId && asset.scanStatus === 'clean') : undefined; if (!media) throw new DomainError('MEDIA_NOT_READY', '媒体资源尚未通过安全检查'); if ((media.kind === 'audio' || media.kind === 'video') && !item.captionText?.trim()) throw new DomainError('CAPTION_REQUIRED', '音视频发布需要字幕或文字稿'); if (media.kind === 'image' && !item.altText?.trim()) throw new DomainError('ALT_TEXT_REQUIRED', '图片发布需要文字替代'); } item.state = 'published'; item.reviewedBy = auth.user.id; item.publishedAt = now(); audit(state, auth.user, 'content.published', 'content', item.id, {}); return item; });
}

/** Retire a previously published education item without deleting its audit
 * history. Retired items immediately disappear from the public listing and
 * any linked media URL becomes unavailable. */
export async function retireContent(store: Store, auth: AuthenticatedUser, contentId: string): Promise<ContentItem> {
  requirePermission(auth.user, 'content:approve');
  return store.transaction((state) => {
    const item = state.contentItems.find((candidate) => candidate.id === contentId && candidate.tenantId === auth.user.tenantId);
    if (!item) throw notFound();
    if (item.state !== 'published') throw new DomainError('CONTENT_STATE_INVALID', '只有已发布内容可以下架');
    item.state = 'retired';
    audit(state, auth.user, 'content.retired', 'content', item.id, {});
    return item;
  });
}

/** Return content-management metadata to authors and professional reviewers.
 * The encrypted body is decrypted only for roles that already have the
 * content workflow permission; storage envelopes and private media bytes are
 * never exposed by this endpoint. */
export async function listContent(store: Store, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!can(auth.user, 'content:write') && !can(auth.user, 'content:approve')) throw forbidden();
  return store.transaction((state) => {
    const items = state.contentItems
      .filter((item) => item.tenantId === auth.user.tenantId)
      .map((item) => {
        const media = item.mediaAssetId ? state.mediaAssets.find((asset) => asset.id === item.mediaAssetId && asset.tenantId === item.tenantId) : undefined;
        return {
          id: item.id,
          title: item.title,
          kind: item.kind,
          ageMin: item.ageMin,
          ageMax: item.ageMax,
          body: decrypt<{ body: string }>(item.bodyCiphertext).body,
          state: item.state,
          copyrightSource: item.copyrightSource,
          mediaAssetId: item.mediaAssetId,
          altText: item.altText,
          captionText: item.captionText,
          ...(media ? { media: { id: media.id, filename: media.filename, mediaType: media.mediaType, kind: media.kind, byteSize: media.byteSize, sha256: media.sha256 } } : {}),
          reviewedBy: item.reviewedBy,
          publishedAt: item.publishedAt,
          createdAt: item.createdAt,
        };
      });
    audit(state, auth.user, 'content.listed', 'content', 'tenant', { count: items.length }, 'content:read');
    return items;
  });
}

export async function listPublicContent(store: Store, age?: number): Promise<Array<Record<string, unknown>>> {
  if (age !== undefined && (!Number.isInteger(age) || age < 6 || age > 19)) throw new DomainError('CONTENT_AGE_INVALID', '内容筛选年龄必须是 6–19 周岁的整数');
  return store.read((state) => state.contentItems.filter((item) => item.state === 'published' && (age === undefined || (age >= item.ageMin && age <= item.ageMax))).map((item) => ({ id: item.id, title: item.title, kind: item.kind, ageMin: item.ageMin, ageMax: item.ageMax, body: decrypt<{ body: string }>(item.bodyCiphertext).body, altText: item.altText, captionText: item.captionText, media: item.mediaAssetId ? (() => { const media = state.mediaAssets.find((asset) => asset.id === item.mediaAssetId && asset.scanStatus === 'clean'); return media ? { id: media.id, filename: media.filename, mediaType: media.mediaType, kind: media.kind, byteSize: media.byteSize, sha256: media.sha256, url: `/v1/content/public/${media.id}/media` } : undefined; })() : undefined, publishedAt: item.publishedAt })));
}

export async function submitProfileResponse(store: Store, auth: AuthenticatedUser, input: { schemaId: string; values: Record<string, unknown> }): Promise<{ id: string; submittedAt: string }> {
  if (!isStudent(auth.user)) throw forbidden();
  requirePermission(auth.user, 'self:assessment');
  if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new DomainError('PROFILE_RESPONSE_INVALID', '调查答案格式无效');
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

export async function campaignProgress(store: Store, auth: AuthenticatedUser, campaignId: string): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'campaign:progress');
  return store.transaction((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && candidate.tenantId === auth.user.tenantId);
    if (!campaign) throw notFound();
    if (auth.user.schoolId && campaign.schoolId !== auth.user.schoolId) throw forbidden();
    const assignments = state.assignments.filter((assignment) => assignment.campaignId === campaign.id && assignment.tenantId === auth.user.tenantId);
    const counts = { assigned: assignments.length, started: assignments.filter((assignment) => ['started', 'completed'].includes(assignment.status)).length, completed: assignments.filter((assignment) => assignment.status === 'completed').length, declined: assignments.filter((assignment) => assignment.status === 'declined').length };
    audit(state, auth.user, 'campaign.progress_viewed', 'campaign', campaign.id, counts);
    return { campaignId: campaign.id, state: campaign.state, ...counts, note: '仅显示任务进度，不包含分数、答案或风险等级。' };
  });
}

export async function createSelfScreening(store: Store, auth: AuthenticatedUser, scaleId: string, requestedAcademicYear?: string): Promise<PublicSelfScreening> {
  if (!isStudent(auth.user)) throw forbidden();
  requirePermission(auth.user, 'self:assessment');
  const academicYear = currentAcademicYear();
  if (requestedAcademicYear !== undefined && (typeof requestedAcademicYear !== 'string' || !requestedAcademicYear.trim() || requestedAcademicYear.trim() !== academicYear)) throw new DomainError('ACADEMIC_YEAR_INVALID', '自选筛查只能使用当前学年');
  return store.transaction((state) => {
    const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
    const scale = state.scales.find((candidate) => candidate.id === scaleId && candidate.tenantId === auth.user.tenantId);
    if (!student || !scale) throw notFound();
    assertUsableScale(scale);
    if (!activeConsent(state, student.id, 'assessment', auth.user.tenantId)) throw new DomainError('CONSENT_REQUIRED', '需要有效的测评参与记录');
    if (!ageAllowed(student, scale)) throw new DomainError('AGE_REVIEW_REQUIRED', '年龄不在该方案适用范围');
    if (state.frequencyReservations.some((reservation) => reservation.tenantId === auth.user.tenantId && reservation.studentId === student.id && reservation.academicYear === academicYear && reservation.status !== 'released')) throw new DomainError('FREQUENCY_REVIEW_REQUIRED', '本学年已有测评场次');
    const campaign: Campaign = { id: id(), tenantId: auth.user.tenantId, schoolId: student.schoolId, name: '学生自选支持筛查（需专业复核）', purpose: 'screening', state: 'open', academicYear, opensAt: now(), closesAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), scaleVersionId: scale.id, reportVisibility: 'professional_review', participantStudentIds: [student.id], createdBy: auth.user.id, publishedAt: now(), createdAt: now() };
    const reservation = { id: id(), tenantId: auth.user.tenantId, studentId: student.id, academicYear, purpose: 'assessment' as const, status: 'reserved' as const, campaignId: campaign.id, createdAt: now() };
    const assignment: Assignment = { id: id(), tenantId: auth.user.tenantId, campaignId: campaign.id, studentId: student.id, frequencyReservationId: reservation.id, status: 'assigned', createdAt: now() };
    state.campaigns.push(campaign); state.frequencyReservations.push(reservation); state.assignments.push(assignment); audit(state, auth.user, 'self_screening.created', 'campaign', campaign.id, { scaleVersionId: scale.id });
    return {
      campaign: { id: campaign.id, name: campaign.name, purpose: campaign.purpose, state: campaign.state, academicYear: campaign.academicYear, opensAt: campaign.opensAt, closesAt: campaign.closesAt, reportVisibility: campaign.reportVisibility },
      assignment: { id: assignment.id, campaignId: assignment.campaignId, status: assignment.status, createdAt: assignment.createdAt },
    };
  });
}

export async function regionalAnalytics(store: Store, auth: AuthenticatedUser): Promise<Record<string, unknown>> {
  requirePermission(auth.user, 'analytics:regional');
  // Cross-school aggregates are a separate processing purpose.  Even a
  // platform-operations role must not turn the endpoint on in production
  // until the receiving scope, suppression policy and school approvals have
  // been recorded outside the application.
  if (process.env.NODE_ENV === 'production' && process.env.CAMPMIND_REGIONAL_ANALYTICS_APPROVED !== 'true') throw new DomainError('REGIONAL_ANALYTICS_NOT_APPROVED', '区域聚合尚未完成用途和接收范围审批', 403);
  return store.transaction((state) => {
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


export async function listStudents(store: Store, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!can(auth.user, 'org:read')) throw forbidden();
  if (auth.user.role === 'teacher') throw forbidden();
  return store.transaction((state) => {
    const students = state.students.filter((student) => student.tenantId === auth.user.tenantId && student.active && (!auth.user.schoolId || student.schoolId === auth.user.schoolId)).map((student) => ({ id: student.id, schoolId: student.schoolId, classId: student.classId, age: student.age, guardianVerified: student.guardianVerified }));
    audit(state, auth.user, 'student.directory_listed', 'student', 'tenant', { count: students.length }, 'org:read');
    return students;
  });
}

/** Return a bounded, metadata-only audit view for the privacy/audit role.
 * Answer, report and care bodies are never stored in the audit envelope; the
 * endpoint therefore exposes only the append-only event metadata needed for
 * review. Listing itself is recorded as a new audit event. */
export async function listAuditEvents(store: Store, auth: AuthenticatedUser, limit = 200): Promise<Array<Record<string, unknown>>> {
  requirePermission(auth.user, 'audit:read');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError('AUDIT_LIMIT_INVALID', '审计事件查询数量必须在 1–200 之间');
  return store.transaction((state) => {
    const events = state.auditEvents
      .filter((event) => event.tenantId === auth.user.tenantId)
      .slice(-limit)
      .map((event) => ({ id: event.id, actorId: event.actorId, action: event.action, objectType: event.objectType, objectId: event.objectId, purpose: event.purpose, metadata: event.metadata, createdAt: event.createdAt }));
    audit(state, auth.user, 'audit.listed', 'audit', 'tenant', { count: events.length, limit }, 'audit:read');
    return events;
  });
}

export async function listCampaigns(store: Store, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  if (!can(auth.user, 'campaign:read')) throw forbidden();
  return store.read((state) => state.campaigns.filter((campaign) => campaign.tenantId === auth.user.tenantId && (!auth.user.schoolId || campaign.schoolId === auth.user.schoolId)).map((campaign) => ({ id: campaign.id, name: campaign.name, purpose: campaign.purpose, state: campaign.state, academicYear: campaign.academicYear, opensAt: campaign.opensAt, closesAt: campaign.closesAt, participantCount: campaign.participantStudentIds.length })));
}

export interface ScaleCatalogFilters {
  status?: ScaleVersion['status'];
  population?: NonNullable<ScaleVersion['population']>;
  minAge?: number;
  maxAge?: number;
}

function validateScaleCatalogFilters(filters: ScaleCatalogFilters): void {
  if (filters.status !== undefined && !['draft', 'approved', 'revoked'].includes(filters.status)) throw new DomainError('SCALE_FILTER_INVALID', '量表状态筛选条件无效');
  if (filters.population !== undefined && !['primary', 'middle', 'high', 'mixed'].includes(filters.population)) throw new DomainError('SCALE_FILTER_INVALID', '量表学段筛选条件无效');
  for (const age of [filters.minAge, filters.maxAge]) if (age !== undefined && (!Number.isInteger(age) || age < 6 || age > 19)) throw new DomainError('SCALE_FILTER_INVALID', '量表年龄筛选条件必须是 6–19 岁整数');
  if (filters.minAge !== undefined && filters.maxAge !== undefined && filters.minAge > filters.maxAge) throw new DomainError('SCALE_FILTER_INVALID', '量表年龄筛选范围无效');
}

export async function listScaleCatalog(store: Store, auth: AuthenticatedUser, filters: ScaleCatalogFilters = {}): Promise<Array<Record<string, unknown>>> {
  if (!isProfessional(auth.user) && !can(auth.user, 'campaign:read')) throw forbidden();
  validateScaleCatalogFilters(filters);
  return store.transaction((state) => {
    const scales = state.scales.filter((scale) => {
      if (scale.tenantId !== auth.user.tenantId) return false;
      if (filters.status && scale.status !== filters.status) return false;
      if (filters.population && (scale.population ?? 'mixed') !== filters.population) return false;
      if (filters.minAge !== undefined && scale.maxAge < filters.minAge) return false;
      if (filters.maxAge !== undefined && scale.minAge > filters.maxAge) return false;
      return true;
    }).map((scale) => {
      const expiry = scale.licenseExpiresAt ? new Date(scale.licenseExpiresAt) : undefined;
      const licenseState = scale.provenance === 'synthetic_only' ? 'synthetic_only' : !expiry ? 'missing_expiry' : Number.isNaN(expiry.getTime()) ? 'invalid_expiry' : expiry <= new Date() ? 'expired' : 'valid';
      return { id: scale.id, code: scale.code, title: scale.title, version: scale.version, provenance: scale.provenance, status: scale.status, minAge: scale.minAge, maxAge: scale.maxAge, scoringVersion: scale.scoringVersion, dimensions: scale.dimensions ?? [], population: scale.population ?? 'mixed', language: scale.language ?? 'zh-CN', licenseExpiresAt: scale.licenseExpiresAt, licenseState };
    });
    audit(state, auth.user, 'scale.catalog_listed', 'scale_version', 'tenant', { count: scales.length, status: filters.status ?? null, population: filters.population ?? null, minAge: filters.minAge ?? null, maxAge: filters.maxAge ?? null }, 'scale:read');
    return scales;
  });
}

export async function listAvailableScales(store: Store, auth: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
  requirePermission(auth.user, 'self:assessment');
  if (!isStudent(auth.user)) throw forbidden();
  return store.transaction((state) => {
    const student = state.students.find((candidate) => candidate.id === auth.user.id && candidate.tenantId === auth.user.tenantId && candidate.active);
    const scales = state.scales.filter((scale) => {
      if (scale.tenantId !== auth.user.tenantId || !student || !ageAllowed(student, scale)) return false;
      try { assertUsableScale(scale); return true; } catch { return false; }
    }).map((scale) => ({ id: scale.id, code: scale.code, title: scale.title, version: scale.version, provenance: scale.provenance, minAge: scale.minAge, maxAge: scale.maxAge, noticeVersion: scale.noticeVersion, dimensions: scale.dimensions ?? [], population: scale.population ?? 'mixed', language: scale.language ?? 'zh-CN', items: scale.items.map((item) => ({ id: item.id, prompt: item.prompt, min: item.min, max: item.max, factor: item.factor })) }));
    audit(state, auth.user, 'scale.available_listed', 'scale_version', 'self', { count: scales.length }, 'self:assessment');
    return scales;
  });
}

function releaseUnusedCampaignReservations(state: DatabaseState, tenantId: string, campaignId: string): void {
  const campaignAssignments = state.assignments.filter((assignment) => assignment.tenantId === tenantId && assignment.campaignId === campaignId);
  const retainedReservationIds = new Set(campaignAssignments.filter((assignment) => {
    if (assignment.status === 'completed') return true;
    const attempt = state.attempts.find((candidate) => candidate.tenantId === tenantId && candidate.assignmentId === assignment.id);
    return Boolean(attempt && ['submitted', 'scoring_pending', 'scored', 'scoring_failed', 'invalid'].includes(attempt.state));
  }).map((assignment) => assignment.frequencyReservationId));
  for (const reservation of state.frequencyReservations.filter((candidate) => candidate.tenantId === tenantId && candidate.campaignId === campaignId && ['reserved', 'exception'].includes(candidate.status) && !retainedReservationIds.has(candidate.id))) reservation.status = 'released';
}

export async function updateCampaignState(store: Store, auth: AuthenticatedUser, campaignId: string, nextState: Campaign['state']): Promise<Campaign> {
  requirePermission(auth.user, 'campaign:write');
  return store.transaction((state) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === campaignId && candidate.tenantId === auth.user.tenantId);
    if (!campaign) throw notFound();
    if (auth.user.schoolId && campaign.schoolId !== auth.user.schoolId) throw forbidden();
    const allowed: Record<Campaign['state'], Campaign['state'][]> = {
      draft: ['approved', 'cancelled'], approved: ['scheduled', 'open', 'cancelled'], scheduled: ['open', 'paused', 'cancelled'], open: ['paused', 'closed'], paused: ['open', 'closed', 'cancelled'], closed: ['archived'], cancelled: ['archived'], archived: [],
    };
    if (!allowed[campaign.state].includes(nextState)) throw new DomainError('CAMPAIGN_STATE_INVALID', '任务状态不能这样变更');
    campaign.state = nextState;
    if (['closed', 'cancelled', 'archived'].includes(nextState)) {
      for (const assignment of state.assignments.filter((candidate) => candidate.tenantId === auth.user.tenantId && candidate.campaignId === campaign.id && ['assigned', 'started'].includes(candidate.status))) {
        const attempt = state.attempts.find((candidate) => candidate.tenantId === auth.user.tenantId && candidate.assignmentId === assignment.id);
        if (!attempt || attempt.state === 'in_progress') { assignment.status = 'expired'; if (attempt) attempt.state = 'expired'; }
      }
      releaseUnusedCampaignReservations(state, auth.user.tenantId, campaign.id);
    }
    audit(state, auth.user, `campaign.${nextState}`, 'campaign', campaign.id, {}); return campaign;
  });
}

export async function revokeReport(store: Store, auth: AuthenticatedUser, reportId: string, reason: string): Promise<void> {
  requirePermission(auth.user, 'report:approve');
  if (typeof reason !== 'string' || !reason.trim()) throw new DomainError('REPORT_REVOCATION_REASON_REQUIRED', '撤回报告需要记录原因');
  return store.transaction((state) => {
    const report = state.reports.find((candidate) => candidate.id === reportId && candidate.tenantId === auth.user.tenantId);
    if (!report || !['approved', 'released'].includes(report.state)) throw notFound();
    if (!professionalCanReadStudent(state, auth, report.studentId)) throw notFound();
    report.state = 'revoked'; report.revokedAt = now(); audit(state, auth.user, 'report.revoked', 'report', report.id, { reason: reason.slice(0, 200) });
  });
}

/** Revoke a scale version without mutating any historical attempt or score. */
export async function revokeScale(store: Store, auth: AuthenticatedUser, scaleId: string, reason: string): Promise<void> {
  requirePermission(auth.user, 'scale:approve');
  if (typeof reason !== 'string' || !reason.trim()) throw new DomainError('SCALE_REVOCATION_REASON_REQUIRED', '撤销量表需要记录原因');
  return store.transaction((state) => {
    const scale = state.scales.find((candidate) => candidate.id === scaleId && candidate.tenantId === auth.user.tenantId);
    if (!scale || scale.status === 'revoked') throw notFound();
    scale.status = 'revoked';
    audit(state, auth.user, 'scale.revoked', 'scale_version', scale.id, { reason: reason.slice(0, 200), version: scale.version });
  });
}
