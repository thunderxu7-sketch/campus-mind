import type { DatabaseState } from '../domain/types.js';
import type { PostgresClient, PostgresPool } from './postgres-context.js';
import { assertTenantContext, withTenantPoolTransaction } from './postgres-context.js';
import type { ExpressionNotice, ExpressionPolicy } from '../domain/types.js';
import type { PostgresStateRepository } from './postgres-store.js';

type AnyRecord = Record<string, unknown>;
type StateCollection = Exclude<keyof DatabaseState, 'schemaVersion' | 'expressionPolicies' | 'expressionNotices'>;
type ValueKind = 'text' | 'date' | 'number' | 'boolean' | 'json';

interface ColumnSpec {
  property: string;
  column: string;
  kind?: ValueKind;
}

interface TableSpec {
  collection: StateCollection;
  table: string;
  columns: ColumnSpec[];
  tenantScoped?: boolean;
  key: string[];
  immutable?: boolean;
  toRecord?: (value: AnyRecord) => AnyRecord;
  fromRecord?: (row: AnyRecord) => AnyRecord;
}

const text = (property: string, column = property): ColumnSpec => ({ property, column, kind: 'text' });
const date = (property: string, column = property): ColumnSpec => ({ property, column, kind: 'date' });
const number = (property: string, column = property): ColumnSpec => ({ property, column, kind: 'number' });
const boolean = (property: string, column = property): ColumnSpec => ({ property, column, kind: 'boolean' });
const json = (property: string, column = property): ColumnSpec => ({ property, column, kind: 'json' });
const optional = (property: string, column = property, kind: ValueKind = 'text'): ColumnSpec => ({ property, column, kind });

function iso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function encodeValue(kind: ValueKind | undefined, value: unknown): unknown {
  if (value === undefined) return null;
  if (kind === 'number') return typeof value === 'number' ? value : Number(value);
  if (kind === 'boolean') return Boolean(value);
  if (kind === 'date') return value instanceof Date ? value.toISOString() : value;
  return value;
}

function decodeValue(kind: ValueKind | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (kind === 'date') return iso(value);
  if (kind === 'number') return typeof value === 'number' ? value : Number(value);
  if (kind === 'boolean') return Boolean(value);
  return value;
}

function defaultToRecord(spec: TableSpec, value: AnyRecord): AnyRecord {
  const row: AnyRecord = {};
  for (const column of spec.columns) row[column.column] = encodeValue(column.kind, value[column.property]);
  return row;
}

function defaultFromRecord(spec: TableSpec, row: AnyRecord): AnyRecord {
  const value: AnyRecord = {};
  if (spec.tenantScoped !== false) value.tenantId = String(row.tenant_id);
  for (const column of spec.columns) {
    const decoded = decodeValue(column.kind, row[column.column]);
    if (decoded !== undefined) value[column.property] = decoded;
  }
  return value;
}

function scaleToRecord(value: AnyRecord): AnyRecord {
  return {
    id: value.id, code: value.code, title: value.title, version: value.version, provenance: value.provenance, status: value.status,
    min_age: value.minAge, max_age: value.maxAge, scoring_version: value.scoringVersion, notice_version: value.noticeVersion,
    config_json: {
      dimensions: value.dimensions ?? [],
      population: value.population ?? 'mixed',
      language: value.language ?? 'zh-CN',
      licenseExpiresAt: value.licenseExpiresAt,
      reviewEvidenceRef: value.reviewEvidenceRef,
      items: value.items ?? [],
      warningRule: value.warningRule,
    },
    created_by: value.createdBy ?? null, approved_by: value.approvedBy ?? null, approved_at: value.approvedAt ?? null, created_at: value.createdAt,
  };
}

function scaleFromRecord(row: AnyRecord): AnyRecord {
  const config = (row.config_json && typeof row.config_json === 'object' ? row.config_json : {}) as AnyRecord;
  return {
    tenantId: String(row.tenant_id), id: String(row.id), code: String(row.code), title: String(row.title), version: String(row.version),
    provenance: String(row.provenance), status: String(row.status), minAge: Number(row.min_age), maxAge: Number(row.max_age),
    scoringVersion: String(row.scoring_version), noticeVersion: String(row.notice_version), dimensions: Array.isArray(config.dimensions) ? config.dimensions : [],
    population: typeof config.population === 'string' ? config.population : 'mixed', language: typeof config.language === 'string' ? config.language : 'zh-CN',
    ...(typeof config.licenseExpiresAt === 'string' ? { licenseExpiresAt: config.licenseExpiresAt } : {}),
    ...(typeof config.reviewEvidenceRef === 'string' ? { reviewEvidenceRef: config.reviewEvidenceRef } : {}),
    items: Array.isArray(config.items) ? config.items : [], ...(config.warningRule && typeof config.warningRule === 'object' ? { warningRule: config.warningRule } : {}),
    ...(row.created_by !== null && row.created_by !== undefined ? { createdBy: String(row.created_by) } : {}),
    ...(row.approved_by !== null && row.approved_by !== undefined ? { approvedBy: String(row.approved_by) } : {}),
    ...(row.approved_at ? { approvedAt: iso(row.approved_at) } : {}), createdAt: iso(row.created_at)!,
  };
}

const specs: readonly TableSpec[] = [
  { collection: 'tenants', table: 'tenants', tenantScoped: false, key: ['id'], columns: [text('id'), text('name'), optional('region'), date('createdAt', 'created_at')] },
  { collection: 'schools', table: 'schools', key: ['id'], columns: [text('id'), text('name'), date('createdAt', 'created_at')] },
  { collection: 'users', table: 'users', key: ['id'], columns: [text('id'), optional('schoolId', 'school_id'), text('email'), text('displayName', 'display_name'), text('passwordHash', 'password_hash'), text('role'), boolean('active'), boolean('mfaEnabled', 'mfa_enabled'), optional('mfaSecretCiphertext', 'mfa_secret_ciphertext'), optional('mfaLastUsedAt', 'mfa_last_used_at', 'date'), date('createdAt', 'created_at')] },
  { collection: 'sessions', table: 'sessions', key: ['token_hash'], columns: [text('tokenHash', 'token_hash'), date('expiresAt', 'expires_at'), date('createdAt', 'created_at'), optional('revokedAt', 'revoked_at', 'date')] },
  { collection: 'students', table: 'students', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('classId', 'class_id'), text('externalRefHash', 'external_ref_hash'), text('displayNameCiphertext', 'display_name_ciphertext'), optional('age', 'age', 'number'), boolean('guardianVerified', 'guardian_verified'), boolean('active'), date('createdAt', 'created_at')] },
  { collection: 'studentAccessCredentials', table: 'student_access_credentials', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('codeHash', 'code_hash'), date('expiresAt', 'expires_at'), text('issuedBy', 'issued_by'), date('createdAt', 'created_at'), optional('usedAt', 'used_at', 'date')] },
  { collection: 'guardianLinks', table: 'guardian_links', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('guardianUserId', 'guardian_user_id'), text('status'), optional('verifiedBy', 'verified_by'), optional('verifiedAt', 'verified_at', 'date'), date('createdAt', 'created_at')] },
  { collection: 'consents', table: 'consents', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('purpose'), text('noticeVersion', 'notice_version'), text('actorType', 'actor_type'), text('actorId', 'actor_id'), text('status'), date('recordedAt', 'recorded_at'), optional('withdrawnAt', 'withdrawn_at', 'date')] },
  { collection: 'scales', table: 'assessment_plans', key: ['id'], columns: [text('id'), text('code'), text('title'), text('version'), text('provenance'), text('status'), number('minAge', 'min_age'), number('maxAge', 'max_age'), text('scoringVersion', 'scoring_version'), text('noticeVersion', 'notice_version'), json('configJson', 'config_json'), optional('createdBy', 'created_by'), optional('approvedBy', 'approved_by'), optional('approvedAt', 'approved_at', 'date'), date('createdAt', 'created_at')], toRecord: scaleToRecord, fromRecord: scaleFromRecord },
  { collection: 'campaigns', table: 'campaigns', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('name'), text('purpose'), text('state'), text('academicYear', 'academic_year'), date('opensAt', 'opens_at'), date('closesAt', 'closes_at'), text('scaleVersionId', 'plan_id'), json('participantStudentIds', 'participant_snapshot'), text('reportVisibility', 'report_visibility'), text('createdBy', 'created_by'), date('createdAt', 'created_at'), optional('publishedAt', 'published_at', 'date')] },
  { collection: 'frequencyReservations', table: 'frequency_reservations', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('academicYear', 'academic_year'), text('purpose'), text('status'), text('campaignId', 'campaign_id'), optional('approvedBy', 'approved_by'), optional('reasonCiphertext', 'reason_ciphertext'), date('createdAt', 'created_at')] },
  { collection: 'assignments', table: 'assignments', key: ['id'], columns: [text('id'), text('campaignId', 'campaign_id'), text('studentId', 'student_id'), text('frequencyReservationId', 'frequency_reservation_id'), text('status'), date('createdAt', 'created_at')] },
  { collection: 'attempts', table: 'attempts', key: ['id'], columns: [text('id'), text('assignmentId', 'assignment_id'), text('studentId', 'student_id'), text('scaleVersionId', 'plan_id'), text('state'), number('currentRevision', 'current_revision'), date('startedAt', 'started_at'), optional('submittedAt', 'submitted_at', 'date'), optional('submissionId', 'submission_id')] },
  { collection: 'answerRevisions', table: 'answer_revisions', key: ['id'], columns: [text('id'), text('attemptId', 'attempt_id'), number('revision'), text('answersCiphertext', 'answers_ciphertext'), date('savedAt', 'saved_at'), text('actorId', 'actor_id')] },
  { collection: 'submissions', table: 'submissions', key: ['id'], columns: [text('id'), text('attemptId', 'attempt_id'), text('answerRevisionId', 'answer_revision_id'), text('idempotencyKey', 'idempotency_key'), text('contentHash', 'content_hash'), date('submittedAt', 'submitted_at')] },
  { collection: 'scoreRuns', table: 'score_runs', key: ['id'], columns: [text('id'), text('submissionId', 'submission_id'), text('scoringVersion', 'scoring_version'), text('status'), json('factorScores', 'factor_scores'), number('total'), text('validity'), optional('completedAt', 'completed_at', 'date'), optional('errorCode', 'error_code')] },
  { collection: 'reports', table: 'reports', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('scoreRunId', 'score_run_id'), text('state'), text('title'), text('summaryCiphertext', 'summary_ciphertext'), text('limitationsCiphertext', 'limitations_ciphertext'), date('createdAt', 'created_at'), optional('approvedBy', 'approved_by'), optional('approvedAt', 'approved_at', 'date'), optional('releasedAt', 'released_at', 'date'), optional('revokedAt', 'revoked_at', 'date')] },
  { collection: 'riskSignals', table: 'risk_signals', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('source'), optional('submissionId', 'submission_id'), optional('scoreRunId', 'score_run_id'), optional('ruleVersion', 'rule_version'), text('level'), text('reasonCiphertext', 'reason_ciphertext'), text('status'), date('createdAt', 'created_at')] },
  { collection: 'riskCases', table: 'risk_cases', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('state'), text('priority'), json('signalIds', 'signal_ids'), optional('assignedTo', 'assigned_to'), optional('closureRequestedBy', 'closure_requested_by'), date('createdAt', 'created_at'), date('updatedAt', 'updated_at'), optional('closureReasonCiphertext', 'closure_reason_ciphertext')] },
  { collection: 'riskReviews', table: 'risk_reviews', key: ['id'], columns: [text('id'), text('caseId', 'case_id'), text('reviewerId', 'reviewer_id'), text('decision'), text('noteCiphertext', 'note_ciphertext'), date('createdAt', 'created_at')] },
  { collection: 'acknowledgements', table: 'case_acknowledgements', key: ['id'], columns: [text('id'), text('caseId', 'case_id'), text('userId', 'user_id'), date('acknowledgedAt', 'acknowledged_at')] },
  { collection: 'followUps', table: 'follow_ups', key: ['id'], columns: [text('id'), text('caseId', 'case_id'), text('authorId', 'author_id'), text('kind'), text('noteCiphertext', 'note_ciphertext'), optional('dueAt', 'due_at', 'date'), date('createdAt', 'created_at')] },
  { collection: 'rightsRequests', table: 'rights_requests', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('kind'), text('requesterId', 'requester_id'), text('status'), optional('reasonCiphertext', 'reason_ciphertext'), optional('decisionReasonCiphertext', 'decision_reason_ciphertext'), optional('resultCiphertext', 'result_ciphertext'), date('createdAt', 'created_at'), optional('completedAt', 'completed_at', 'date')] },
  { collection: 'deletionTombstones', table: 'deletion_tombstones', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('requestId', 'request_id'), date('deletedAt', 'deleted_at'), json('retainedCategories', 'retained_categories')] },
  { collection: 'exportJobs', table: 'export_jobs', key: ['id'], columns: [text('id'), text('requestedBy', 'requested_by'), text('purpose'), optional('approvedBy', 'approved_by'), text('kind'), optional('studentId', 'student_id'), text('status'), date('expiresAt', 'expires_at'), optional('payloadCiphertext', 'payload_ciphertext'), date('createdAt', 'created_at'), optional('approvedAt', 'approved_at', 'date')] },
  { collection: 'outboxEvents', table: 'outbox_events', key: ['id'], columns: [text('id'), text('type'), text('aggregateId', 'aggregate_id'), json('payload'), text('status'), number('attempts'), date('availableAt', 'available_at'), date('createdAt', 'created_at'), optional('cancelledAt', 'cancelled_at', 'date'), optional('cancelReasonCode', 'cancel_reason_code')] },
  { collection: 'deliveryAttempts', table: 'delivery_attempts', key: ['id'], columns: [text('id'), text('outboxEventId', 'outbox_event_id'), text('channel'), text('status'), date('attemptedAt', 'attempted_at'), optional('errorCode', 'error_code')] },
  { collection: 'auditEvents', table: 'audit_events', key: ['id'], immutable: true, columns: [text('id'), optional('actorId', 'actor_id'), text('action'), text('objectType', 'object_type'), text('objectId', 'object_id'), optional('purpose'), json('metadata'), date('createdAt', 'created_at')] },
  { collection: 'availabilitySlots', table: 'availability_slots', key: ['id'], columns: [text('id'), text('counselorId', 'counselor_id'), date('startsAt', 'starts_at'), date('endsAt', 'ends_at'), optional('room'), text('status')] },
  { collection: 'appointments', table: 'appointments', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('counselorId', 'counselor_id'), text('slotId', 'slot_id'), text('state'), optional('noteCiphertext', 'note_ciphertext'), optional('idempotencyKey', 'idempotency_key'), optional('idempotencyHash', 'idempotency_hash'), date('createdAt', 'created_at'), date('updatedAt', 'updated_at')] },
  { collection: 'mediaAssets', table: 'media_assets', key: ['id'], columns: [text('id'), text('filename'), text('mediaType', 'media_type'), text('kind'), number('byteSize', 'byte_size'), text('sha256'), text('contentCiphertext', 'content_ciphertext'), optional('objectKey', 'object_key'), text('scanStatus', 'scan_status'), text('createdBy', 'created_by'), date('createdAt', 'created_at')] },
  { collection: 'contentItems', table: 'content_items', key: ['id'], columns: [text('id'), text('title'), text('kind'), number('ageMin', 'age_min'), number('ageMax', 'age_max'), text('bodyCiphertext', 'body_ciphertext'), text('state'), text('copyrightSource', 'copyright_source'), text('createdBy', 'created_by'), optional('mediaAssetId', 'media_asset_id'), optional('altText', 'alt_text'), optional('captionText', 'caption_text'), optional('reviewedBy', 'reviewed_by'), optional('publishedAt', 'published_at', 'date'), date('createdAt', 'created_at')] },
  { collection: 'profileSchemas', table: 'profile_schemas', key: ['id'], columns: [text('id'), text('version'), json('fields'), text('state'), optional('approvedBy', 'approved_by'), date('createdAt', 'created_at')] },
  { collection: 'profileResponses', table: 'profile_responses', key: ['id'], columns: [text('id'), text('studentId', 'student_id'), text('schemaId', 'schema_id'), text('valuesCiphertext', 'values_ciphertext'), date('submittedAt', 'submitted_at')] },
  { collection: 'importBatches', table: 'import_batches', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('createdBy', 'created_by'), text('filename'), text('status'), number('mappingVersion', 'mapping_version'), number('rowCount', 'row_count'), number('validRowCount', 'valid_row_count'), number('errorCount', 'error_count'), text('previewHash', 'preview_hash'), date('createdAt', 'created_at')] },
  { collection: 'importRows', table: 'import_rows', key: ['id'], columns: [text('id'), text('batchId', 'batch_id'), number('rowNumber', 'row_number'), text('status'), optional('message'), optional('syntheticStudentId', 'synthetic_student_id')] },
  { collection: 'expressionEntries', table: 'expression_entries', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('studentId', 'student_id'), text('source'), optional('payloadCiphertext', 'payload_ciphertext'), text('consentId', 'consent_id'), text('noticeVersion', 'notice_version'), date('createdAt', 'created_at'), date('expiresAt', 'expires_at'), optional('deletedAt', 'deleted_at', 'date'), text('idempotencyKey', 'idempotency_key'), text('requestDigest', 'request_digest'), text('digestKeyVersion', 'digest_key_version')] },
  { collection: 'expressionShares', table: 'expression_shares', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('studentId', 'student_id'), text('entryId', 'entry_id'), text('recipientId', 'recipient_id'), text('consentId', 'consent_id'), text('noticeVersion', 'notice_version'), text('status'), date('createdAt', 'created_at'), date('expiresAt', 'expires_at'), optional('revokedAt', 'revoked_at', 'date'), text('idempotencyKey', 'idempotency_key'), text('requestDigest', 'request_digest'), text('digestKeyVersion', 'digest_key_version')] },
  { collection: 'supportRequests', table: 'support_requests', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('studentId', 'student_id'), text('recipientId', 'recipient_id'), optional('shareId', 'share_id'), text('consentId', 'consent_id'), text('noticeVersion', 'notice_version'), text('state'), number('version'), text('policyVersion', 'policy_version'), date('createdAt', 'created_at'), date('updatedAt', 'updated_at'), date('ackDueAt', 'ack_due_at'), optional('firstAcknowledgedAt', 'first_acknowledged_at', 'date'), optional('nextFollowUpAt', 'next_follow_up_at', 'date'), optional('closedAt', 'closed_at', 'date'), optional('cancellationReason', 'cancellation_reason'), text('idempotencyKey', 'idempotency_key'), text('requestDigest', 'request_digest'), text('digestKeyVersion', 'digest_key_version')] },
  { collection: 'supportNotes', table: 'support_notes', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('requestId', 'request_id'), text('authorId', 'author_id'), text('noteCiphertext', 'note_ciphertext'), date('createdAt', 'created_at'), text('idempotencyKey', 'idempotency_key'), text('requestDigest', 'request_digest'), text('digestKeyVersion', 'digest_key_version')] },
  { collection: 'expressionRevocations', table: 'expression_revocations', key: ['id'], columns: [text('id'), text('schoolId', 'school_id'), text('studentId', 'student_id'), text('targetType', 'target_type'), text('targetId', 'target_id'), text('effect'), date('recordedAt', 'recorded_at')] },
] as const;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error('SQL_IDENTIFIER_INVALID');
  return `"${identifier}"`;
}

function valueKey(spec: TableSpec, value: AnyRecord): string {
  return spec.key.map((key) => String(value[key === 'token_hash' ? 'tokenHash' : key])).join('\u0000');
}

function rowFor(spec: TableSpec, value: AnyRecord, tenantId: string): AnyRecord {
  const row = (spec.toRecord ?? ((item: AnyRecord) => defaultToRecord(spec, item)))(value);
  if (spec.tenantScoped !== false) row.tenant_id = tenantId;
  return row;
}

function valueFrom(spec: TableSpec, row: AnyRecord): AnyRecord {
  return (spec.fromRecord ?? ((record: AnyRecord) => defaultFromRecord(spec, record)))(row);
}

function queryForRows(spec: TableSpec): string {
  const columns = spec.tenantScoped === false ? spec.columns.map((column) => quoteIdentifier(column.column)) : ['tenant_id', ...spec.columns.map((column) => quoteIdentifier(column.column))];
  const predicate = spec.tenantScoped === false ? `${quoteIdentifier(spec.key[0]!)} = $1` : `tenant_id = $1`;
  return `select ${columns.join(', ')} from ${quoteIdentifier(spec.table)} where ${predicate}`;
}

async function readTable(client: PostgresClient, spec: TableSpec, tenantId: string): Promise<AnyRecord[]> {
  const result = await client.query<AnyRecord>(queryForRows(spec), [tenantId]);
  return result.rows.map((row) => valueFrom(spec, row));
}

function keyWhere(spec: TableSpec, row: AnyRecord, tenantId: string): { clause: string; values: unknown[] } {
  const values: unknown[] = [];
  const predicates: string[] = [];
  if (spec.tenantScoped !== false) { values.push(tenantId); predicates.push('tenant_id = $1'); }
  for (const key of spec.key) {
    const property = key === 'token_hash' ? 'tokenHash' : key;
    values.push(row[property]); predicates.push(`${quoteIdentifier(key)} = $${values.length}`);
  }
  return { clause: predicates.join(' and '), values };
}

async function deleteRow(client: PostgresClient, spec: TableSpec, row: AnyRecord, tenantId: string): Promise<void> {
  const where = keyWhere(spec, row, tenantId);
  await client.query(`delete from ${quoteIdentifier(spec.table)} where ${where.clause}`, where.values);
}

async function upsertRow(client: PostgresClient, spec: TableSpec, row: AnyRecord, tenantId: string): Promise<void> {
  const encoded = rowFor(spec, row, tenantId);
  const columns = Object.keys(encoded);
  const values = columns.map((column) => encoded[column]);
  const conflict = spec.tenantScoped === false ? spec.key : ['tenant_id', ...spec.key];
  const updates = columns.filter((column) => !conflict.includes(column)).map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const action = spec.immutable ? 'do nothing' : `do update set ${updates.join(', ')}`;
  await client.query(`insert into ${quoteIdentifier(spec.table)} (${columns.map(quoteIdentifier).join(', ')}) values (${placeholders.join(', ')}) on conflict (${conflict.map(quoteIdentifier).join(', ')}) ${action}`, values);
}

async function loadState(client: PostgresClient, tenantId: string, expressionPolicies: readonly ExpressionPolicy[], expressionNotices: readonly ExpressionNotice[]): Promise<DatabaseState> {
  const state: DatabaseState = { schemaVersion: 2, tenants: [], schools: [], users: [], sessions: [], studentAccessCredentials: [], students: [], consents: [], expressionPolicies: structuredClone([...expressionPolicies]), expressionNotices: structuredClone([...expressionNotices]), expressionEntries: [], expressionShares: [], supportRequests: [], supportNotes: [], expressionRevocations: [], scales: [], campaigns: [], guardianLinks: [], assignments: [], frequencyReservations: [], attempts: [], answerRevisions: [], submissions: [], scoreRuns: [], reports: [], riskSignals: [], riskCases: [], riskReviews: [], acknowledgements: [], followUps: [], auditEvents: [], outboxEvents: [], importBatches: [], importRows: [], rightsRequests: [], deletionTombstones: [], exportJobs: [], deliveryAttempts: [], availabilitySlots: [], appointments: [], contentItems: [], mediaAssets: [], profileSchemas: [], profileResponses: [] };
  for (const spec of specs) state[spec.collection] = await readTable(client, spec, tenantId) as never;
  return state;
}

async function persistState(client: PostgresClient, before: DatabaseState, after: DatabaseState, tenantId: string): Promise<void> {
  for (const spec of [...specs].reverse()) {
    if (spec.immutable) continue;
    const beforeValues = before[spec.collection] as unknown as AnyRecord[];
    const afterValues = after[spec.collection] as unknown as AnyRecord[];
    const afterKeys = new Set(afterValues.map((value) => valueKey(spec, value)));
    for (const value of beforeValues) if (!afterKeys.has(valueKey(spec, value))) await deleteRow(client, spec, value, tenantId);
  }
  for (const spec of specs) {
    const beforeValues = before[spec.collection] as unknown as AnyRecord[];
    const beforeKeys = new Set(beforeValues.map((value) => valueKey(spec, value)));
    const afterValues = after[spec.collection] as unknown as AnyRecord[];
    for (const value of afterValues) {
      const tenantValue = spec.tenantScoped === false ? String(value.id) : String(value.tenantId);
      if (spec.tenantScoped !== false && tenantValue !== tenantId) throw new Error('TENANT_SCOPE_VIOLATION');
      if (spec.immutable && beforeKeys.has(valueKey(spec, value))) continue;
      await upsertRow(client, spec, value, tenantId);
    }
  }
}

export interface NormalizedPostgresStateRepositoryOptions {
  pool: PostgresPool;
  expressionPolicies?: readonly ExpressionPolicy[];
  expressionNotices?: readonly ExpressionNotice[];
  migrationVersion?: number;
}

/**
 * Normalized PostgreSQL repository for the complete DatabaseState contract.
 * Every read/write runs in a transaction-local tenant context and all table
 * names/columns are fixed descriptors above; caller input never becomes SQL.
 * The replacement write is protected by a transaction advisory lock so two
 * domain callbacks for one tenant cannot lose each other's changes.
 */
export class NormalizedPostgresStateRepository implements PostgresStateRepository {
  readonly kind = 'postgres' as const;
  private readyState = false;
  private readonly pool: PostgresPool;
  private readonly expressionPolicies: readonly ExpressionPolicy[];
  private readonly expressionNotices: readonly ExpressionNotice[];
  private readonly migrationVersion: number;

  constructor(options: NormalizedPostgresStateRepositoryOptions) {
    if (!options?.pool) throw new Error('POSTGRES_POOL_REQUIRED');
    this.pool = options.pool;
    this.expressionPolicies = options.expressionPolicies ?? [];
    this.expressionNotices = options.expressionNotices ?? [];
    this.migrationVersion = options.migrationVersion ?? 2;
  }

  static async create(options: NormalizedPostgresStateRepositoryOptions): Promise<NormalizedPostgresStateRepository> {
    const repository = new NormalizedPostgresStateRepository(options);
    await repository.healthCheck();
    return repository;
  }

  get ready(): boolean {
    return this.readyState;
  }

  private assertReady(): void {
    if (!this.readyState) throw new Error('POSTGRES_REPOSITORY_NOT_READY');
  }

  async read<T>(tenantId: string, fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    assertTenantContext(tenantId);
    this.assertReady();
    return withTenantPoolTransaction(this.pool, tenantId, async (client) => fn(await loadState(client, tenantId, this.expressionPolicies, this.expressionNotices)));
  }

  async transaction<T>(tenantId: string, fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    assertTenantContext(tenantId);
    this.assertReady();
    return withTenantPoolTransaction(this.pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [tenantId]);
      const before = await loadState(client, tenantId, this.expressionPolicies, this.expressionNotices);
      const working = structuredClone(before);
      const result = await fn(working);
      await persistState(client, before, working, tenantId);
      return result;
    });
  }

  async healthCheck(): Promise<{ schemaVersion: number; rlsEnforced: true }> {
    this.readyState = false;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ count: string | number }>("select count(*)::int as count from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[]) and relrowsecurity and relforcerowsecurity", [specs.map((spec) => spec.table)]);
      if (Number(result.rows[0]?.count ?? 0) !== specs.length) throw new Error('POSTGRES_RLS_NOT_READY');
      this.readyState = true;
      return { schemaVersion: this.migrationVersion, rlsEnforced: true };
    } finally { client.release(); }
  }

  async close(): Promise<void> {
    const pool = this.pool as PostgresPool & { end?: () => Promise<void> };
    await pool.end?.();
  }
}

export function postgresStateTableNames(): readonly string[] {
  return specs.map((spec) => spec.table);
}
