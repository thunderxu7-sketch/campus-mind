import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const PASSWORD_PREFIX = 'scrypt';
const KEY_LENGTH = 32;
const DEV_MASTER = 'campus-mind-development-only-master-key-change-me';

export function masterKey(): Buffer {
  const configured = process.env.CAMPMIND_MASTER_KEY;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('CAMPMIND_MASTER_KEY must be configured in production');
  }
  return createHash('sha256').update(configured ?? DEV_MASTER).digest();
}

export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error('密码至少需要 12 个字符');
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${PASSWORD_PREFIX}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [prefix, saltText, digestText] = encoded.split('$');
  if (prefix !== PASSWORD_PREFIX || !saltText || !digestText) return false;
  try {
    const expected = Buffer.from(digestText, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), KEY_LENGTH, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** AES-256-GCM envelope; ciphertext is safe to put in the local demo store. */
export function encrypt(value: unknown, key = masterKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((part) => part.toString('base64url')).join('.');
}

export function decrypt<T>(envelope: string, key = masterKey()): T {
  const [ivText, tagText, bodyText] = envelope.split('.');
  if (!ivText || !tagText || !bodyText) throw new Error('无效的加密数据');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const body = Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]);
  return JSON.parse(body.toString('utf8')) as T;
}
