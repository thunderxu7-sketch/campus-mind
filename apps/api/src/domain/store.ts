import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseState } from './types.js';
import type { PrivateObjectStore } from '../infra/object-store.js';

export interface MediaScanResult {
  status: 'clean' | 'rejected';
  /** Provider identifier is intentionally not persisted in student-facing data. */
  provider: string;
}

export interface MediaScanner {
  scan(input: { tenantId: string; filename: string; mediaType: string; bytes: Uint8Array }): Promise<MediaScanResult>;
}

export function emptyState(): DatabaseState {
  return {
    schemaVersion: 1,
    tenants: [], schools: [], users: [], sessions: [], studentAccessCredentials: [], students: [], consents: [], scales: [], campaigns: [],
    guardianLinks: [], assignments: [], frequencyReservations: [], attempts: [], answerRevisions: [], submissions: [], scoreRuns: [],
    reports: [], riskSignals: [], riskCases: [], riskReviews: [], acknowledgements: [], followUps: [], auditEvents: [],
    outboxEvents: [], importBatches: [], importRows: [], rightsRequests: [], deletionTombstones: [], exportJobs: [], deliveryAttempts: [], availabilitySlots: [], appointments: [], contentItems: [], mediaAssets: [], profileSchemas: [], profileResponses: [],
  };
}

export interface StoreOptions { filePath?: string; initial?: DatabaseState; objectStore?: PrivateObjectStore; mediaScanner?: MediaScanner; }

/**
 * Persistence contract consumed by the domain layer.  `JsonStore` is only a
 * local reference implementation; production can inject a PostgreSQL-backed
 * implementation without coupling business rules to a file adapter.
 */
export interface Store {
  transaction<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  /** Adapter identity is explicit so production cannot accept an arbitrary in-memory substitute. */
  readonly adapterKind?: 'json' | 'postgres';
  /** Private media/object storage boundary. Production must inject a managed private adapter. */
  readonly objectStore?: PrivateObjectStore;
  /** Malware scanning boundary. Production must inject a provider-backed scanner. */
  readonly mediaScanner?: MediaScanner;
}

/** The local adapter is deliberately unavailable to a production entrypoint.
 * A deployment must inject a PostgreSQL-backed adapter into createApp/worker;
 * silently writing psychological records to a JSON file is not an acceptable
 * fallback. */
export function assertProductionStoreInjection(store?: Store): void {
  if (process.env.NODE_ENV === 'production' && (!store || store instanceof JsonStore || store.adapterKind !== 'postgres' || !store.objectStore || !store.mediaScanner)) throw new Error('Production requires an injected PostgreSQL-backed store, private object-store and media-scanner adapters; JsonStore is reference-only');
}

/**
 * A deliberately small local persistence adapter. It makes the reference app runnable without a service dependency.
 * Production must use the PostgreSQL migrations and enforce the same domain invariants in a transaction.
 */
export class JsonStore implements Store {
  private state: DatabaseState;
  private lock: Promise<void> = Promise.resolve();
  private readonly filePath?: string;
  readonly adapterKind = 'json' as const;
  readonly objectStore?: PrivateObjectStore;
  readonly mediaScanner?: MediaScanner;

  constructor(options: StoreOptions = {}) {
    this.filePath = options.filePath;
    this.objectStore = options.objectStore;
    this.mediaScanner = options.mediaScanner;
    if (options.initial) {
      this.state = { ...emptyState(), ...structuredClone(options.initial) };
      this.persist();
    } else if (this.filePath && existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<DatabaseState>;
      this.state = { ...emptyState(), ...parsed };
    }
    else this.state = emptyState();
  }

  snapshot(): DatabaseState { return structuredClone(this.state); }

  async transaction<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      this.state = draft;
      this.persist();
      return result;
    } finally { release(); }
  }

  async read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    await previous;
    return fn(this.snapshot());
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.filePath);
  }
}
