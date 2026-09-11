import { randomUUID } from 'node:crypto';
import { encrypt } from './crypto.js';
import { hashPassword } from './crypto.js';
import type { DatabaseState, ScaleVersion, User } from './types.js';
import { emptyState } from './store.js';

export const DEMO_PASSWORD = 'CampusMind-Demo-2026!';
export const DEMO_IDS = {
  tenant: 'tenant-demo',
  school: 'school-demo',
  student: 'student-demo',
  scale: 'scale-synthetic-demo-v1',
  campaign: 'campaign-demo',
  assignment: 'assignment-demo',
};

export function seedDemoState(): DatabaseState {
  const state = emptyState();
  const createdAt = new Date().toISOString();
  state.tenants.push({ id: DEMO_IDS.tenant, name: '演示学校租户（合成数据）', region: 'demo-region', createdAt });
  state.schools.push({ id: DEMO_IDS.school, tenantId: DEMO_IDS.tenant, name: '演示中学', createdAt });
  const user = (id: string, email: string, displayName: string, role: User['role'], schoolId?: string, mfaEnabled = false): User => ({ id, tenantId: DEMO_IDS.tenant, schoolId, email, displayName, passwordHash: hashPassword(DEMO_PASSWORD), role, active: true, mfaEnabled, createdAt });
  state.users.push(
    user('user-ops-demo', 'ops@campus-mind.demo', '演示平台运维', 'platform_ops', undefined, true),
    user('user-privacy-demo', 'privacy@campus-mind.demo', '演示隐私审计员', 'privacy_auditor', DEMO_IDS.school),
    user('user-admin-demo', 'admin@campus-mind.demo', '演示校务管理员', 'school_admin', DEMO_IDS.school, true),
    user('user-professional-demo', 'professional@campus-mind.demo', '演示心理专业负责人', 'professional_lead', DEMO_IDS.school),
    user('user-counselor-demo', 'counselor@campus-mind.demo', '演示心理咨询师', 'counselor', DEMO_IDS.school),
    user('user-teacher-demo', 'teacher@campus-mind.demo', '演示班主任', 'teacher', DEMO_IDS.school),
    user(DEMO_IDS.student, 'student@campus-mind.demo', '演示学生', 'student', DEMO_IDS.school),
  );
  state.students.push({ id: DEMO_IDS.student, tenantId: DEMO_IDS.tenant, schoolId: DEMO_IDS.school, classId: 'class-demo-1', externalRefHash: 'synthetic-demo-ref', displayNameCiphertext: encrypt('演示学生'), age: 15, guardianVerified: true, active: true, createdAt });
  state.consents.push({ id: 'consent-demo', tenantId: DEMO_IDS.tenant, studentId: DEMO_IDS.student, purpose: 'assessment', noticeVersion: 'notice-demo-v1', actorType: 'guardian', actorId: 'synthetic-guardian', status: 'active', recordedAt: createdAt });
  const scale: ScaleVersion = {
    id: DEMO_IDS.scale,
    tenantId: DEMO_IDS.tenant,
    code: 'SYNTH-5',
    title: '演示情绪与压力自评（合成示例）',
    version: '1.0.0',
    provenance: 'synthetic_only',
    status: 'approved',
    minAge: 12,
    maxAge: 18,
    scoringVersion: 'synthetic-scoring-v1',
    noticeVersion: 'notice-demo-v1',
    items: [
      { id: 'q1', prompt: '演示题：我能说出最近需要帮助的事情。', min: 0, max: 1, reverse: false, factor: 'self_awareness' },
      { id: 'q2', prompt: '演示题：我能找到一种让自己平静下来的方法。', min: 0, max: 1, reverse: false, factor: 'emotion_support' },
      { id: 'q3', prompt: '演示题：遇到困难时，我愿意向可信任的人求助。', min: 0, max: 1, reverse: false, factor: 'help_seeking' },
      { id: 'q4', prompt: '演示题：我最近感到学习和生活压力需要被关注。', min: 0, max: 1, reverse: false, factor: 'stress_notice' },
      { id: 'q5', prompt: '演示题：我知道学校可以提供哪些支持。', min: 0, max: 1, reverse: false, factor: 'support_access' },
    ],
    warningRule: { threshold: 4, level: 'attention', reason: '合成演示规则命中，仅用于验证人工复核流程；不代表临床阈值。' },
    approvedBy: 'user-professional-demo',
    approvedAt: createdAt,
  };
  state.scales.push(scale);
  state.campaigns.push({ id: DEMO_IDS.campaign, tenantId: DEMO_IDS.tenant, schoolId: DEMO_IDS.school, name: '演示学年心理支持自评', purpose: 'screening', state: 'open', academicYear: '2026-2027', opensAt: new Date(Date.now() - 86_400_000).toISOString(), closesAt: new Date(Date.now() + 86_400_000 * 30).toISOString(), scaleVersionId: scale.id, reportVisibility: 'professional_review', participantStudentIds: [DEMO_IDS.student], createdBy: 'user-admin-demo', publishedAt: createdAt, createdAt });
  state.frequencyReservations.push({ id: 'frequency-demo', tenantId: DEMO_IDS.tenant, studentId: DEMO_IDS.student, academicYear: '2026-2027', purpose: 'assessment', status: 'reserved', campaignId: DEMO_IDS.campaign, createdAt });
  state.assignments.push({ id: DEMO_IDS.assignment, tenantId: DEMO_IDS.tenant, campaignId: DEMO_IDS.campaign, studentId: DEMO_IDS.student, frequencyReservationId: 'frequency-demo', status: 'assigned', createdAt });
  return state;
}

export function seedIfEmpty(state: DatabaseState): DatabaseState {
  return state.users.length === 0 ? seedDemoState() : state;
}

export function randomDemoId(): string { return randomUUID(); }
