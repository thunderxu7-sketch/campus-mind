import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const PASSWORD_PREFIX = 'scrypt';
const KEY_LENGTH = 32;
const DEV_MASTER = 'campus-mind-development-only-master-key-change-me';

/** Fail closed until the reference adapters are replaced by production ones. */
export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const configured = process.env.CAMPMIND_MASTER_KEY;
  if (!configured || configured.length < 32 || configured === DEV_MASTER || configured === 'local-only-key') throw new Error('CAMPMIND_MASTER_KEY must be a dedicated production secret');
  if (process.env.CAMPMIND_DEMO_MFA === 'true') throw new Error('CAMPMIND_DEMO_MFA is forbidden in production');
  if (process.env.CAMPMIND_DATA_BACKEND !== 'postgres') throw new Error('CAMPMIND_DATA_BACKEND=postgres is required in production');
}

export function masterKey(): Buffer {
  const configured = process.env.CAMPMIND_MASTER_KEY;
  assertProductionConfig();
  return createHash('sha256').update(configured ?? DEV_MASTER).digest();
}

/**
 * Return the active encryption key followed by explicitly configured legacy
 * keys. During rotation, new values always use the first key while decrypting
 * remains backwards-compatible until the re-encryption job has completed.
 * Previous keys are supplied through a secret manager-backed environment
 * value; they are never persisted in the repository or returned to callers.
 */
export function masterKeyCandidates(): Buffer[] {
  const current = masterKey();
  const raw = process.env.CAMPMIND_PREVIOUS_MASTER_KEYS;
  if (!raw?.trim()) return [current];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 3 || values.some((value) => value.length < 32 || value === DEV_MASTER || value === 'local-only-key')) throw new Error('CAMPMIND_PREVIOUS_MASTER_KEYS must contain at most three dedicated secrets');
  return [current, ...values.map((value) => createHash('sha256').update(value).digest())];
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

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
  const normalized = secret.toUpperCase().replace(/[=\s-]/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new Error('invalid TOTP secret');
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 0xff); }
  }
  return Buffer.from(bytes);
}

/** RFC 6238-compatible six-digit TOTP for an enrolled MFA secret. */
export function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(secret: string, code: string, atMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    // Accept one adjacent 30-second step for normal clock skew, without
    // accepting arbitrary replay windows.
    return [-1, 0, 1].some((offset) => {
      const expected = Buffer.from(totpCode(secret, atMs + offset * 30_000));
      const actual = Buffer.from(code);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
  } catch { return false; }
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
  const keys = arguments.length > 1 ? [key] : masterKeyCandidates();
  let lastError: unknown;
  for (const candidate of keys) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', candidate, Buffer.from(ivText, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      const body = Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]);
      return JSON.parse(body.toString('utf8')) as T;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error('无效的加密数据');
}

/** Decrypt with the active/legacy key ring and immediately emit an envelope
 * under the active key. Callers can use this in a bounded rotation worker. */
export function reencrypt<T>(envelope: string): string {
  return encrypt(decrypt<T>(envelope));
}
