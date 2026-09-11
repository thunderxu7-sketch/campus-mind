import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseState } from './types.js';

export function emptyState(): DatabaseState {
  return {
    schemaVersion: 1,
    tenants: [], schools: [], users: [], sessions: [], students: [], consents: [], scales: [], campaigns: [],
    assignments: [], frequencyReservations: [], attempts: [], answerRevisions: [], submissions: [], scoreRuns: [],
    reports: [], riskSignals: [], riskCases: [], riskReviews: [], acknowledgements: [], followUps: [], auditEvents: [],
    outboxEvents: [], importBatches: [], importRows: [], rightsRequests: [], deletionTombstones: [], exportJobs: [], deliveryAttempts: [], availabilitySlots: [], appointments: [], contentItems: [], profileSchemas: [], profileResponses: [],
  };
}

export interface StoreOptions { filePath?: string; initial?: DatabaseState; }

/**
 * A deliberately small local persistence adapter. It makes the reference app runnable without a service dependency.
 * Production must use the PostgreSQL migrations and enforce the same domain invariants in a transaction.
 */
export class JsonStore {
  private state: DatabaseState;
  private lock: Promise<void> = Promise.resolve();
  private readonly filePath?: string;

  constructor(options: StoreOptions = {}) {
    this.filePath = options.filePath;
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
