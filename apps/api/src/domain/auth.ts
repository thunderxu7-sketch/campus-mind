import { randomUUID } from 'node:crypto';
import { DomainError, forbidden, unauthorized } from './errors.js';
import { assertProductionConfig, decrypt, hashPassword, hashToken, randomToken, verifyPassword, verifyTotpCode } from './crypto.js';
import type { AuthenticatedUser, DatabaseState, Role, Session, User } from './types.js';
import type { Store } from './store.js';

const SESSION_DAYS = 8;

export const rolePermissions: Record<Role, readonly string[]> = {
  platform_ops: ['tenant:configure', 'system:metrics', 'analytics:regional'],
  school_admin: ['org:read', 'org:manage', 'import:write', 'campaign:write', 'campaign:read', 'analytics:read', 'export:request', 'appointment:manage', 'content:write'],
  professional_lead: ['org:read', 'campaign:read', 'frequency:approve', 'scale:write', 'scale:approve', 'report:read', 'report:approve', 'case:read', 'case:review', 'case:assign', 'case:ack', 'care:write', 'analytics:read', 'export:request', 'export:approve', 'rights:manage', 'appointment:manage', 'content:write', 'content:approve', 'profile:write', 'profile:approve'],
  counselor: ['org:read', 'campaign:read', 'report:read', 'case:read', 'case:review', 'case:ack', 'care:write'],
  teacher: ['org:read', 'campaign:read', 'campaign:progress'],
  student: ['self:read', 'self:assessment', 'self:help', 'self:appointment'],
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
