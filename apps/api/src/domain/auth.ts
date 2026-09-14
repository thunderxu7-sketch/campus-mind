import { randomUUID } from 'node:crypto';
import { DomainError, forbidden, unauthorized } from './errors.js';
import { assertProductionConfig, decrypt, hashPassword, hashToken, randomToken, verifyPassword, verifyTotpCode } from './crypto.js';
import type { AuthenticatedUser, DatabaseState, Role, Session, User } from './types.js';
import type { Store } from './store.js';

const SESSION_DAYS = 8;
const STUDENT_CREDENTIAL_SESSION_HOURS = 8;
const STUDENT_CREDENTIAL_DEFAULT_MINUTES = 30;
const STUDENT_CREDENTIAL_MAX_MINUTES = 24 * 60;

export const rolePermissions: Record<Role, readonly string[]> = {
  platform_ops: ['tenant:configure', 'system:metrics', 'analytics:regional'],
  school_admin: ['org:read', 'org:manage', 'import:write', 'campaign:write', 'campaign:read', 'analytics:read', 'export:request', 'appointment:manage', 'content:write'],
  professional_lead: ['org:read', 'campaign:read', 'frequency:approve', 'scale:write', 'scale:approve', 'report:read', 'report:approve', 'case:read', 'case:review', 'case:assign', 'case:ack', 'care:write', 'analytics:read', 'export:request', 'export:approve', 'rights:manage', 'appointment:manage', 'content:write', 'content:approve', 'profile:write', 'profile:approve', 'expression:shared-read', 'support:assigned-manage', 'support:escalation-metadata'],
  counselor: ['org:read', 'campaign:read', 'report:read', 'case:read', 'case:review', 'case:ack', 'care:write', 'expression:shared-read', 'support:assigned-manage'],
  teacher: ['org:read', 'campaign:read', 'campaign:progress'],
  student: ['self:read', 'self:assessment', 'self:help', 'self:appointment', 'self:expression'],
  guardian: ['self:read', 'rights:request'],
  privacy_auditor: ['audit:read', 'rights:read', 'rights:manage', 'analytics:read', 'export:approve'],
};

export function can(user: User, permission: string): boolean {
  return rolePermissions[user.role]?.includes(permission) ?? false;
}

export function requirePermission(user: User, permission: string): void {
  if (!can(user, permission)) throw forbidden();
}

export function safeUser(user: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _passwordHash, mfaSecretCiphertext: _mfaSecretCiphertext, mfaLastUsedAt: _mfaLastUsedAt, ...publicUser } = user;
  return publicUser;
}

export async function login(store: Store, email: string, password: string, mfaCode?: string): Promise<{ token: string; user: Omit<User, 'passwordHash'>; expiresAt: string }> {
  assertProductionConfig();
  const normalized = email.trim().toLowerCase();
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
  await store.transaction((state) => {
    const user = state.users.find((candidate) => candidate.email === normalized && candidate.active);
    if (!user || !verifyPassword(password, user.passwordHash)) throw new DomainError('INVALID_CREDENTIALS', '邮箱或密码错误', 401);
    if (user.mfaEnabled && process.env.CAMPMIND_DEMO_MFA !== 'true') {
      if (typeof mfaCode !== 'string' || !mfaCode.trim()) throw new DomainError('MFA_REQUIRED', '需要完成管理账号二次验证', 401);
      if (!user.mfaSecretCiphertext) throw new DomainError('MFA_NOT_CONFIGURED', '管理账号尚未配置二次验证，请联系平台管理员', 503);
      let secret = '';
      try { secret = decrypt<{ secret: string }>(user.mfaSecretCiphertext).secret; } catch { throw new DomainError('MFA_NOT_CONFIGURED', '管理账号二次验证配置无效', 503); }
      if (!verifyTotpCode(secret, mfaCode.trim())) throw new DomainError('MFA_INVALID', '二次验证码无效或已过期', 401);
      if (user.mfaLastUsedAt && Number.isFinite(Date.parse(user.mfaLastUsedAt)) && now.getTime() - Date.parse(user.mfaLastUsedAt) < 30_000) throw new DomainError('MFA_REPLAYED', '二次验证码已使用，请等待下一验证码', 401);
      user.mfaLastUsedAt = now.toISOString();
    }
    state.sessions = state.sessions.filter((session) => session.expiresAt > now.toISOString() && !session.revokedAt);
    state.sessions.push({ tokenHash: hashToken(token), userId: user.id, tenantId: user.tenantId, expiresAt, createdAt: now.toISOString() });
  });
  const user = await store.read((state) => state.users.find((candidate) => candidate.email === normalized));
  if (!user) throw unauthorized();
  return { token, user: safeUser(user), expiresAt };
}

export interface StudentAccessCodeResult {
  id: string;
  studentId: string;
  code: string;
  expiresAt: string;
}

/** Issue a one-time, short-lived credential for a student using a shared or
 * phone-less school terminal. The raw code is returned exactly once; only a
 * hash is persisted. */
export async function issueStudentAccessCode(store: Store, auth: AuthenticatedUser, studentId: string, ttlMinutes = STUDENT_CREDENTIAL_DEFAULT_MINUTES): Promise<StudentAccessCodeResult> {
  if (!can(auth.user, 'org:manage')) throw forbidden();
  if (typeof studentId !== 'string' || !studentId.trim() || !Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > STUDENT_CREDENTIAL_MAX_MINUTES) throw new DomainError('STUDENT_CREDENTIAL_INVALID', '学生凭证对象或有效期无效');
  const code = randomToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000).toISOString();
  return store.transaction((state) => {
    const student = state.students.find((candidate) => candidate.id === studentId && candidate.tenantId === auth.user.tenantId && candidate.active);
    const user = state.users.find((candidate) => candidate.id === studentId && candidate.tenantId === auth.user.tenantId && candidate.role === 'student' && candidate.active);
    if (!student || !user || (auth.user.schoolId && student.schoolId !== auth.user.schoolId)) throw new DomainError('STUDENT_CREDENTIAL_INVALID', '学生凭证对象无效', 404);
    // Issuing a new printed code invalidates any still-active code for the
    // same student, avoiding two simultaneous credentials on a shared device.
    for (const previous of state.studentAccessCredentials.filter((credential) => credential.tenantId === auth.user.tenantId && credential.studentId === studentId && !credential.usedAt && credential.expiresAt > createdAt.toISOString())) previous.usedAt = createdAt.toISOString();
    const credential = { id: randomUUID(), tenantId: auth.user.tenantId, studentId, codeHash: hashToken(code), expiresAt, issuedBy: auth.user.id, createdAt: createdAt.toISOString() };
    state.studentAccessCredentials.push(credential);
    // The credential object ID and bounded TTL are enough for audit review;
    // do not duplicate the student's identifier into searchable metadata.
    state.auditEvents.push({ id: randomUUID(), tenantId: auth.user.tenantId, actorId: auth.user.id, action: 'student.credential_issued', objectType: 'student_access_credential', objectId: credential.id, purpose: 'student_login', metadata: { ttlMinutes }, createdAt: createdAt.toISOString() });
    return { id: credential.id, studentId, code, expiresAt };
  });
}

/** Redeem a printed student code once, creating a short session without
 * requiring an email, phone number or reusable shared password. */
export async function loginWithStudentAccessCode(store: Store, code: string): Promise<{ token: string; user: Omit<User, 'passwordHash'>; expiresAt: string }> {
  assertProductionConfig();
  if (typeof code !== 'string' || code.length < 20 || code.length > 256) throw new DomainError('STUDENT_CREDENTIAL_INVALID', '学生凭证无效或已过期', 401);
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STUDENT_CREDENTIAL_SESSION_HOURS * 60 * 60_000).toISOString();
  return store.transaction((state) => {
    const credential = state.studentAccessCredentials.find((candidate) => candidate.codeHash === hashToken(code) && !candidate.usedAt && candidate.expiresAt > now.toISOString());
    const user = credential ? state.users.find((candidate) => candidate.id === credential.studentId && candidate.tenantId === credential.tenantId && candidate.role === 'student' && candidate.active) : undefined;
    if (!credential || !user) throw new DomainError('STUDENT_CREDENTIAL_INVALID', '学生凭证无效或已过期', 401);
    credential.usedAt = now.toISOString();
    state.sessions = state.sessions.filter((session) => session.expiresAt > now.toISOString() && !session.revokedAt);
    state.sessions.push({ tokenHash: hashToken(token), userId: user.id, tenantId: user.tenantId, expiresAt, createdAt: now.toISOString() });
    state.auditEvents.push({ id: randomUUID(), tenantId: user.tenantId, actorId: user.id, action: 'student.credential_redeemed', objectType: 'student_access_credential', objectId: credential.id, purpose: 'student_login', metadata: {}, createdAt: now.toISOString() });
    return { token, user: safeUser(user), expiresAt };
  });
}

/** Revoke every active session for a scoped user during offboarding or a
 * shared-terminal incident. The target is checked in the same tenant/school
 * boundary as the issuer. */
export async function revokeUserSessions(store: Store, auth: AuthenticatedUser, targetUserId: string): Promise<{ revoked: number }> {
  if (!can(auth.user, 'org:manage')) throw forbidden();
  if (typeof targetUserId !== 'string' || !targetUserId.trim()) throw new DomainError('SESSION_REVOKE_INVALID', '会话撤销对象无效');
  return store.transaction((state) => {
    const target = state.users.find((candidate) => candidate.id === targetUserId && candidate.tenantId === auth.user.tenantId && candidate.active);
    if (!target || (auth.user.schoolId && target.schoolId !== auth.user.schoolId)) throw new DomainError('SESSION_REVOKE_INVALID', '会话撤销对象无效', 404);
    const revokedAt = new Date().toISOString();
    let revoked = 0;
    for (const session of state.sessions.filter((candidate) => candidate.tenantId === auth.user.tenantId && candidate.userId === target.id && !candidate.revokedAt)) { session.revokedAt = revokedAt; revoked += 1; }
    for (const credential of state.studentAccessCredentials.filter((candidate) => candidate.tenantId === auth.user.tenantId && candidate.studentId === target.id && !candidate.usedAt)) credential.usedAt = revokedAt;
    state.auditEvents.push({ id: randomUUID(), tenantId: auth.user.tenantId, actorId: auth.user.id, action: 'session.revoked', objectType: 'user', objectId: target.id, purpose: 'security', metadata: { revoked }, createdAt: revokedAt });
    return { revoked };
  });
}

export async function authenticate(store: Store, authorization: string | undefined): Promise<AuthenticatedUser> {
  if (!authorization?.startsWith('Bearer ')) throw unauthorized();
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw unauthorized();
  const now = new Date().toISOString();
  return store.read((state: DatabaseState) => {
    const session = state.sessions.find((candidate) => candidate.tokenHash === hashToken(token) && !candidate.revokedAt && candidate.expiresAt > now);
    if (!session) throw unauthorized();
    const user = state.users.find((candidate) => candidate.id === session.userId && candidate.active && candidate.tenantId === session.tenantId);
    if (!user) throw unauthorized();
    return { user, session };
  });
}

export async function logout(store: Store, session: Session): Promise<void> {
  await store.transaction((state) => {
    const record = state.sessions.find((candidate) => candidate.tokenHash === session.tokenHash);
    if (record) record.revokedAt = new Date().toISOString();
  });
}

export function provisionPassword(password: string): string { return hashPassword(password); }

export function isProfessional(user: User): boolean {
  return user.role === 'professional_lead' || user.role === 'counselor';
}

export function isStudent(user: User): boolean { return user.role === 'student'; }
