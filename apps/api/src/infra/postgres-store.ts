import type { IdentityRepository, Store } from '../domain/store.js';
import type { DatabaseState } from '../domain/types.js';
import type { PrivateObjectStore } from './object-store.js';
import { requireTenantContext } from './postgres-context.js';
import type { MediaScanner, NotificationDispatcher } from '../domain/store.js';

/**
 * The domain layer intentionally works with a state-shaped Store so the
 * reference adapter remains easy to exercise. The production repository is
 * responsible for loading that shape from normalized PostgreSQL tables and
 * persisting the callback's changes in one tenant-scoped transaction.
 *
 * Keeping this interface driver-neutral prevents the domain package from
 * importing a pool implementation or accidentally creating a second database
 * client with different RLS settings. A repository implementation must use
 * `withTenantPoolTransaction` (or an equivalent reviewed helper) internally.
 */
export interface PostgresStateRepository {
  readonly kind: 'postgres';
  readonly ready: boolean;
  read<T>(tenantId: string, fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  transaction<T>(tenantId: string, fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  healthCheck(): Promise<{ schemaVersion: number; rlsEnforced: true }>;
  close?(): Promise<void>;
}

export interface PostgresStoreOptions {
  repository: PostgresStateRepository;
  identityRepository: IdentityRepository;
  objectStore: PrivateObjectStore;
  mediaScanner: MediaScanner;
  notificationDispatcher: NotificationDispatcher;
}

/**
 * Production Store boundary. This class is deliberately small: SQL mapping,
 * migrations and provider-specific clients belong in the injected repository
 * and adapter bundle, not in route/domain code. It is not a fake fallback — a
 * missing or non-ready repository is rejected at construction time.
 */
export class PostgresStore implements Store {
  readonly adapterKind = 'postgres' as const;
  readonly objectStore: PrivateObjectStore;
  readonly mediaScanner: MediaScanner;
  readonly notificationDispatcher: NotificationDispatcher;
  readonly identityRepository: IdentityRepository;
  private readonly repository: PostgresStateRepository;

  get productionReady(): boolean {
    return this.repository.ready;
  }

  constructor(options: PostgresStoreOptions) {
    if (!options?.repository || options.repository.kind !== 'postgres' || options.repository.ready !== true) throw new Error('POSTGRES_REPOSITORY_NOT_READY');
    if (!options.identityRepository) throw new Error('IDENTITY_REPOSITORY_REQUIRED');
    if (!options.objectStore) throw new Error('PRIVATE_OBJECT_STORE_REQUIRED');
    if (!options.mediaScanner) throw new Error('MEDIA_SCANNER_REQUIRED');
    if (!options.notificationDispatcher) throw new Error('NOTIFICATION_DISPATCHER_REQUIRED');
    this.repository = options.repository;
    this.identityRepository = options.identityRepository;
    this.objectStore = options.objectStore;
    this.mediaScanner = options.mediaScanner;
    this.notificationDispatcher = options.notificationDispatcher;
  }

  async read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    return this.repository.read(requireTenantContext(), fn);
  }

  async transaction<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    return this.repository.transaction(requireTenantContext(), fn);
  }

  healthCheck(): Promise<{ schemaVersion: number; rlsEnforced: true }> {
    return this.repository.healthCheck();
  }

  close(): Promise<void> {
    return this.repository.close?.() ?? Promise.resolve();
  }
}
