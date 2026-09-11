import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { masterKey, masterKeyCandidates } from '../domain/crypto.js';

const ENVELOPE_VERSION = 1;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface StoredObject {
  objectKey: string;
  tenantId: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  bytes: Buffer;
}

export interface PrivateObjectStore {
  put(input: { tenantId: string; objectKey: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject>;
  get(input: { tenantId: string; objectKey: string }): Promise<StoredObject>;
  delete(input: { tenantId: string; objectKey: string }): Promise<void>;
  /** Rewrite an object with the active key after a rotation window. */
  reencrypt?(input: { tenantId: string; objectKey: string }): Promise<StoredObject>;
}

function assertPart(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n]/.test(value) || value.startsWith('/') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`${label}_INVALID`);
}

function assertObjectKey(objectKey: string): void {
  assertPart(objectKey, 'OBJECT_KEY');
  if (!/^[A-Za-z0-9._/-]+$/.test(objectKey)) throw new Error('OBJECT_KEY_INVALID');
}

function assertTenant(tenantId: string): void { assertPart(tenantId, 'TENANT_ID'); }

function tenantKey(tenantId: string, key = masterKey()): Buffer {
  return createHmac('sha256', key).update(`campus-mind/object-store/${tenantId}`).digest();
}

function fileFor(rootDir: string, tenantId: string, objectKey: string): string {
  const tenantHash = createHash('sha256').update(tenantId).digest('hex');
  const keyHash = createHash('sha256').update(objectKey).digest('hex');
  return join(rootDir, tenantHash.slice(0, 2), `${tenantHash}-${keyHash}.blob`);
}

function cleanupTempFiles(directory: string): number {
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) removed += cleanupTempFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.tmp')) { unlinkSync(path); removed += 1; }
  }
  return removed;
}

function associatedData(tenantId: string, objectKey: string, contentType: string, byteSize: number, sha256: string): Buffer {
  return Buffer.from(`${tenantId}\0${objectKey}\0${contentType}\0${byteSize}\0${sha256}`, 'utf8');
}

interface Envelope {
  version: number;
  tenantId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Local/private reference object storage. Objects are encrypted per tenant,
 * addressed by a hashed path, written with mode 0600 and never exposed as a
 * public URL. Production should replace this class with a private S3-like
 * adapter that preserves the same tenant/key contract.
 */
export class EncryptedFileObjectStore implements PrivateObjectStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options: { rootDir: string; maxBytes?: number }) {
    if (!options?.rootDir || typeof options.rootDir !== 'string') throw new Error('OBJECT_STORE_ROOT_REQUIRED');
    this.rootDir = options.rootDir;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 100 * 1024 * 1024) throw new Error('OBJECT_STORE_LIMIT_INVALID');
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootDir, 0o700);
    cleanupTempFiles(this.rootDir);
  }

  async put(input: { tenantId: string; objectKey: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject> {
    assertTenant(input.tenantId);
    assertObjectKey(input.objectKey);
    if (typeof input.contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.contentType) || input.contentType.length > 128) throw new Error('CONTENT_TYPE_INVALID');
    const bytes = Buffer.from(input.bytes);
    if (!bytes.length || bytes.length > this.maxBytes) throw new Error('OBJECT_TOO_LARGE');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', tenantKey(input.tenantId), iv);
    cipher.setAAD(associatedData(input.tenantId, input.objectKey, input.contentType, bytes.length, sha256));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope: Envelope = {
      version: ENVELOPE_VERSION,
      tenantId: input.tenantId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: bytes.length,
      sha256,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    const filename = fileFor(this.rootDir, input.tenantId, input.objectKey);
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    chmodSync(dirname(filename), 0o700);
    const temp = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify(envelope), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, filename);
    return { objectKey: input.objectKey, tenantId: input.tenantId, contentType: input.contentType, byteSize: bytes.length, sha256, bytes };
  }

  async get(input: { tenantId: string; objectKey: string }): Promise<StoredObject> {
    assertTenant(input.tenantId);
    assertObjectKey(input.objectKey);
    const filename = fileFor(this.rootDir, input.tenantId, input.objectKey);
    if (!existsSync(filename)) throw new Error('OBJECT_NOT_FOUND');
    let envelope: Envelope;
    try { envelope = JSON.parse(readFileSync(filename, 'utf8')) as Envelope; } catch { throw new Error('OBJECT_CORRUPT'); }
    if (envelope.version !== ENVELOPE_VERSION || envelope.tenantId !== input.tenantId || envelope.objectKey !== input.objectKey || typeof envelope.contentType !== 'string' || !Number.isInteger(envelope.byteSize) || envelope.byteSize < 1 || envelope.byteSize > this.maxBytes) throw new Error('OBJECT_CORRUPT');
    for (const key of masterKeyCandidates()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', tenantKey(input.tenantId, key), Buffer.from(envelope.iv, 'base64url'));
        decipher.setAAD(associatedData(input.tenantId, input.objectKey, envelope.contentType, envelope.byteSize, envelope.sha256));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
        const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
        if (bytes.length !== envelope.byteSize || createHash('sha256').update(bytes).digest('hex') !== envelope.sha256) throw new Error('hash mismatch');
        return { objectKey: input.objectKey, tenantId: input.tenantId, contentType: envelope.contentType, byteSize: bytes.length, sha256: envelope.sha256, bytes };
      } catch { /* try the next explicitly configured rotation key */ }
    }
    throw new Error('OBJECT_CORRUPT');
  }

  async delete(input: { tenantId: string; objectKey: string }): Promise<void> {
    assertTenant(input.tenantId);
    assertObjectKey(input.objectKey);
    const filename = fileFor(this.rootDir, input.tenantId, input.objectKey);
    if (existsSync(filename)) unlinkSync(filename);
  }

  /**
   * Read through the bounded active/legacy key ring and atomically write the
   * same object using the active key.  Callers should run this from a bounded,
   * observable migration job and remove legacy keys only after verification.
   */
  async reencrypt(input: { tenantId: string; objectKey: string }): Promise<StoredObject> {
    const current = await this.get(input);
    return this.put({ tenantId: current.tenantId, objectKey: current.objectKey, contentType: current.contentType, bytes: current.bytes });
  }
}
