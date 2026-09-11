export type Role =
  | 'platform_ops'
  | 'school_admin'
  | 'professional_lead'
  | 'counselor'
  | 'teacher'
  | 'student'
  | 'guardian'
  | 'privacy_auditor';

export type CampaignState = 'draft' | 'approved' | 'scheduled' | 'open' | 'paused' | 'closed' | 'cancelled' | 'archived';
export type AttemptState = 'not_started' | 'in_progress' | 'submitted' | 'scoring_pending' | 'scored' | 'scoring_failed' | 'invalid' | 'withdrawn' | 'expired';
export type ReportState = 'draft' | 'pending_review' | 'approved' | 'released' | 'revoked';
export type CaseState = 'pending_review' | 'dismissed' | 'confirmed' | 'assigned' | 'in_support' | 'follow_up' | 'closure_requested' | 'closed';
export type SignalSource = 'score_rule' | 'self_request' | 'staff_observation' | 'external_referral';
export type RightsKind = 'access' | 'correct' | 'delete' | 'withdraw';
export type AppointmentState = 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type ContentState = 'draft' | 'professional_review' | 'published' | 'retired';
export type MediaKind = 'image' | 'audio' | 'video' | 'subtitle';

export interface Tenant {
  id: string;
  name: string;
  region?: string;
  createdAt: string;
}

export interface School {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  schoolId?: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  mfaEnabled: boolean;
  /** Encrypted TOTP secret; never returned by safeUser or API responses. */
  mfaSecretCiphertext?: string;
  /** Last accepted MFA time marker used to reject immediate code replay. */
  mfaLastUsedAt?: string;
  createdAt: string;
}

export interface Session {
  tokenHash: string;
  userId: string;
  tenantId: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

/** One-time, short-lived credential for students who cannot use a phone. */
export interface StudentAccessCredential {
  id: string;
  tenantId: string;
  studentId: string;
  codeHash: string;
  expiresAt: string;
  issuedBy: string;
  createdAt: string;
  usedAt?: string;
}

export interface Student {
  id: string;
  tenantId: string;
  schoolId: string;
  classId: string;
  displayNameCiphertext: string;
  externalRefHash: string;
  age?: number;
  guardianVerified: boolean;
  active: boolean;
  createdAt: string;
}

export interface ConsentRecord {
  id: string;
  tenantId: string;
  studentId: string;
  purpose: 'assessment' | 'support' | 'research';
  noticeVersion: string;
  actorType: 'student' | 'guardian' | 'school_legal_basis';
  actorId: string;
  status: 'active' | 'withdrawn' | 'expired';
  recordedAt: string;
  withdrawnAt?: string;
}

export interface GuardianLink {
  id: string;
  tenantId: string;
  studentId: string;
  guardianUserId: string;
  status: 'pending' | 'verified' | 'revoked';
  verifiedBy?: string;
  verifiedAt?: string;
  createdAt: string;
}

export interface ScaleItem {
  id: string;
  prompt: string;
  min: number;
  max: number;
  reverse: boolean;
  factor: string;
}

export interface ScaleVersion {
  id: string;
  tenantId: string;
  code: string;
  title: string;
  version: string;
  provenance: 'synthetic_only' | 'licensed';
  status: 'draft' | 'approved' | 'revoked';
  minAge: number;
  maxAge: number;
  scoringVersion: string;
  noticeVersion: string;
  /** Optional catalog metadata used for age/grade suitability review. */
  dimensions?: string[];
  population?: 'primary' | 'middle' | 'high' | 'mixed';
  language?: string;
  licenseExpiresAt?: string;
  reviewEvidenceRef?: string;
  items: ScaleItem[];
  warningRule?: { threshold: number; level: 'attention' | 'urgent'; reason: string };
  /** Named author retained for author/approver separation. */
  createdBy?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface Campaign {
  id: string;
  tenantId: string;
  schoolId: string;
  name: string;
  purpose: 'screening' | 'survey';
  state: CampaignState;
  academicYear: string;
  opensAt: string;
  closesAt: string;
  scaleVersionId: string;
  reportVisibility: 'professional_review' | 'student_after_release';
  participantStudentIds: string[];
  createdBy: string;
  publishedAt?: string;
  createdAt: string;
}

export interface Assignment {
  id: string;
  tenantId: string;
  campaignId: string;
  studentId: string;
  frequencyReservationId: string;
  status: 'assigned' | 'started' | 'completed' | 'declined' | 'expired';
  createdAt: string;
}

export interface FrequencyReservation {
  id: string;
  tenantId: string;
  studentId: string;
  academicYear: string;
  purpose: 'assessment';
  status: 'reserved' | 'consumed' | 'released' | 'exception';
  campaignId: string;
  approvedBy?: string;
  reason?: string;
  createdAt: string;
}

export interface AnswerRevision {
  id: string;
  tenantId: string;
  attemptId: string;
  revision: number;
  answersCiphertext: string;
  savedAt: string;
  actorId: string;
}

export interface Attempt {
  id: string;
  tenantId: string;
  assignmentId: string;
  studentId: string;
  scaleVersionId: string;
  state: AttemptState;
  currentRevision: number;
  startedAt: string;
  submittedAt?: string;
  submissionId?: string;
}

export interface Submission {
  id: string;
  tenantId: string;
  attemptId: string;
  answerRevisionId: string;
  idempotencyKey: string;
  contentHash: string;
  submittedAt: string;
}

export interface ScoreRun {
  id: string;
  tenantId: string;
  submissionId: string;
  scoringVersion: string;
  status: 'pending' | 'completed' | 'failed';
  factorScores: Record<string, number>;
  total: number;
  validity: 'valid' | 'invalid';
  completedAt?: string;
  errorCode?: string;
}

export interface ReportVersion {
  id: string;
  tenantId: string;
  studentId: string;
  scoreRunId: string;
  state: ReportState;
  title: string;
  summaryCiphertext: string;
  limitationsCiphertext: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  releasedAt?: string;
  revokedAt?: string;
}

export interface RiskSignal {
  id: string;
  tenantId: string;
  studentId: string;
  source: SignalSource;
  submissionId?: string;
  scoreRunId?: string;
  ruleVersion?: string;
  level: 'attention' | 'urgent';
  reasonCiphertext: string;
  createdAt: string;
  status: 'open' | 'reviewed' | 'dismissed';
}

export interface RiskCase {
  id: string;
  tenantId: string;
  studentId: string;
  state: CaseState;
  priority: 'attention' | 'urgent';
  signalIds: string[];
  assignedTo?: string;
  /** Actor who submitted the current closure request; used for separation of duties. */
  closureRequestedBy?: string;
  createdAt: string;
  updatedAt: string;
  closureReasonCiphertext?: string;
}

export interface RiskReview {
  id: string;
  tenantId: string;
  caseId: string;
  reviewerId: string;
  decision: 'dismiss' | 'confirm';
  noteCiphertext: string;
  createdAt: string;
}

export interface CaseAcknowledgement {
  id: string;
  tenantId: string;
  caseId: string;
  userId: string;
  acknowledgedAt: string;
}

export interface FollowUp {
  id: string;
  tenantId: string;
  caseId: string;
  authorId: string;
  kind: 'support' | 'referral' | 'follow_up';
  noteCiphertext: string;
  dueAt?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorId?: string;
  action: string;
  objectType: string;
  objectId: string;
  purpose?: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface OutboxEvent {
  id: string;
  tenantId: string;
  type: string;
  aggregateId: string;
  payload: Record<string, string | number | boolean | null>;
  status: 'pending' | 'published' | 'dead_letter';
  attempts: number;
  availableAt: string;
  createdAt: string;
}

export interface ImportBatch {
  id: string;
  tenantId: string;
  schoolId: string;
  createdBy: string;
  filename: string;
  status: 'previewed' | 'committed' | 'rejected';
  mappingVersion: number;
  rowCount: number;
  validRowCount: number;
  errorCount: number;
  /** Stable hash of the exact preview payload; commit must match it. */
  previewHash?: string;
  createdAt: string;
}

export interface RightsRequest {
  id: string;
  tenantId: string;
  studentId: string;
  kind: RightsKind;
  requesterId: string;
  status: 'open' | 'processing' | 'completed' | 'rejected';
  reason?: string;
  /** Encrypted rationale recorded by the privacy reviewer for the decision. */
  decisionReasonCiphertext?: string;
  resultCiphertext?: string;
  createdAt: string;
  completedAt?: string;
}

export interface DeletionTombstone {
  id: string;
  tenantId: string;
  studentId: string;
  requestId: string;
  deletedAt: string;
  retainedCategories: string[];
}

export interface ExportJob {
  id: string;
  tenantId: string;
  requestedBy: string;
  /** A bounded, governance-facing purpose code for the export. */
  purpose: string;
  approvedBy?: string;
  kind: 'aggregate' | 'report';
  studentId?: string;
  status: 'requested' | 'approved' | 'ready' | 'expired' | 'revoked';
  expiresAt: string;
  payloadCiphertext?: string;
  createdAt: string;
  approvedAt?: string;
}

export interface DeliveryAttempt {
  id: string;
  tenantId: string;
  outboxEventId: string;
  channel: 'in_app' | 'sms' | 'email';
  status: 'queued' | 'sent' | 'failed';
  attemptedAt: string;
  errorCode?: string;
}

export interface AvailabilitySlot {
  id: string;
  tenantId: string;
  counselorId: string;
  startsAt: string;
  endsAt: string;
  room?: string;
  status: 'available' | 'held' | 'blocked';
}

export interface Appointment {
  id: string;
  tenantId: string;
  studentId: string;
  counselorId: string;
  slotId: string;
  state: AppointmentState;
  noteCiphertext?: string;
  /** Optional client idempotency key for safe retry of a booking request. */
  idempotencyKey?: string;
  /** Hash of the request shape used to reject key reuse with different data. */
  idempotencyHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentItem {
  id: string;
  tenantId: string;
  title: string;
  kind: 'article' | 'announcement' | 'media';
  ageMin: number;
  ageMax: number;
  bodyCiphertext: string;
  state: ContentState;
  copyrightSource: string;
  createdBy: string;
  mediaAssetId?: string;
  altText?: string;
  captionText?: string;
  reviewedBy?: string;
  publishedAt?: string;
  createdAt: string;
}

export interface MediaAsset {
  id: string;
  tenantId: string;
  filename: string;
  mediaType: string;
  kind: MediaKind;
  byteSize: number;
  sha256: string;
  contentCiphertext: string;
  /** Optional private object-store pointer. Legacy reference records keep encrypted inline content. */
  objectKey?: string;
  scanStatus: 'clean' | 'rejected';
  createdBy: string;
  createdAt: string;
}

export interface ProfileResponse {
  id: string;
  tenantId: string;
  studentId: string;
  schemaId: string;
  valuesCiphertext: string;
  submittedAt: string;
}

export interface ProfileSchemaVersion {
  id: string;
  tenantId: string;
  version: string;
  fields: Array<{ id: string; label: string; purpose: string; required: boolean; sensitive: boolean }>;
  state: 'draft' | 'approved' | 'retired';
  approvedBy?: string;
  createdAt: string;
}

export interface ImportRowResult {
  id: string;
  tenantId: string;
  batchId: string;
  rowNumber: number;
  status: 'valid' | 'error';
  message?: string;
  syntheticStudentId?: string;
}

export interface DatabaseState {
  schemaVersion: number;
  tenants: Tenant[];
  schools: School[];
  users: User[];
  sessions: Session[];
  studentAccessCredentials: StudentAccessCredential[];
  students: Student[];
  guardianLinks: GuardianLink[];
  consents: ConsentRecord[];
  scales: ScaleVersion[];
  campaigns: Campaign[];
  assignments: Assignment[];
  frequencyReservations: FrequencyReservation[];
  attempts: Attempt[];
  answerRevisions: AnswerRevision[];
  submissions: Submission[];
  scoreRuns: ScoreRun[];
  reports: ReportVersion[];
  riskSignals: RiskSignal[];
  riskCases: RiskCase[];
  riskReviews: RiskReview[];
  acknowledgements: CaseAcknowledgement[];
  followUps: FollowUp[];
  auditEvents: AuditEvent[];
  outboxEvents: OutboxEvent[];
  importBatches: ImportBatch[];
  importRows: ImportRowResult[];
  rightsRequests: RightsRequest[];
  deletionTombstones: DeletionTombstone[];
  exportJobs: ExportJob[];
  deliveryAttempts: DeliveryAttempt[];
  availabilitySlots: AvailabilitySlot[];
  appointments: Appointment[];
  contentItems: ContentItem[];
  mediaAssets: MediaAsset[];
  profileSchemas: ProfileSchemaVersion[];
  profileResponses: ProfileResponse[];
}

export interface AuthenticatedUser {
  user: User;
  session: Session;
}
