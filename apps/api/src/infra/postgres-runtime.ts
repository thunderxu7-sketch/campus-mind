import { Pool, type PoolConfig } from 'pg';
import type { PostgresPool, PostgresPoolClient, QueryResult } from './postgres-context.js';

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export interface PostgresRuntimeOptions {
  /** Prefer an injected secret-manager value; never commit this to the repo. */
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
  /** `true` requires certificate validation to be configured by the driver. */
  ssl?: boolean | { rejectUnauthorized: boolean; ca?: string };
  /** Keep pool errors observable without logging URLs, credentials or SQL. */
  onPoolError?: (error: { name: string; code?: string }) => void;
}

export interface ResolvedPostgresRuntimeOptions {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  applicationName: string;
  ssl?: boolean | { rejectUnauthorized: boolean; ca?: string };
}

function envValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function envNumber(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const value = envValue(name, env);
  return value === undefined ? undefined : Number(value);
}

function boundedInteger(value: number | undefined, fallback: number, invalidCode: string, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) throw new Error(invalidCode);
  return resolved;
}

function assertConnectionString(connectionString: string): void {
  if (connectionString.length > 4_096 || /[\0\r\n]/.test(connectionString) || !/^postgres(?:ql)?:\/\//i.test(connectionString)) throw new Error('POSTGRES_URL_INVALID');
}

/**
 * Resolve only bounded, non-secret pool settings. The URL is passed through
 * to `pg` but is never returned in an error, log or health response.
 */
export function resolvePostgresRuntimeOptions(options: PostgresRuntimeOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedPostgresRuntimeOptions {
  const connectionString = options.connectionString?.trim() || envValue('CAMPMIND_POSTGRES_URL', env) || envValue('DATABASE_URL', env);
  if (!connectionString) throw new Error('POSTGRES_URL_REQUIRED');
  assertConnectionString(connectionString);
  const max = boundedInteger(options.max ?? envNumber('CAMPMIND_POSTGRES_POOL_MAX', env), DEFAULT_POOL_MAX, 'POSTGRES_POOL_MAX_INVALID', 100);
  const idleTimeoutMillis = boundedInteger(options.idleTimeoutMillis ?? envNumber('CAMPMIND_POSTGRES_IDLE_TIMEOUT_MS', env), DEFAULT_IDLE_TIMEOUT_MS, 'POSTGRES_IDLE_TIMEOUT_INVALID', 300_000);
  const connectionTimeoutMillis = boundedInteger(options.connectionTimeoutMillis ?? envNumber('CAMPMIND_POSTGRES_CONNECTION_TIMEOUT_MS', env), DEFAULT_CONNECTION_TIMEOUT_MS, 'POSTGRES_CONNECTION_TIMEOUT_INVALID', 60_000);
  const applicationName = options.applicationName?.trim() || envValue('CAMPMIND_POSTGRES_APPLICATION_NAME', env) || 'campus-mind-api';
  if (applicationName.length > 128 || /[\0\r\n]/.test(applicationName)) throw new Error('POSTGRES_APPLICATION_NAME_INVALID');
  const ssl = options.ssl ?? (envValue('CAMPMIND_POSTGRES_SSL', env) === 'true' ? { rejectUnauthorized: envValue('CAMPMIND_POSTGRES_SSL_REJECT_UNAUTHORIZED', env) !== 'false' } : undefined);
  if (env.NODE_ENV === 'production' && !ssl) throw new Error('POSTGRES_TLS_REQUIRED');
  if (env.NODE_ENV === 'production' && typeof ssl === 'object' && ssl.rejectUnauthorized !== true) throw new Error('POSTGRES_TLS_VERIFY_REQUIRED');
  return { connectionString, max, idleTimeoutMillis, connectionTimeoutMillis, applicationName, ...(ssl ? { ssl } : {}) };
}

function asPoolConfig(options: ResolvedPostgresRuntimeOptions): PoolConfig {
  return {
    connectionString: options.connectionString,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    application_name: options.applicationName,
    ...(options.ssl ? { ssl: options.ssl } : {}),
  };
}

export interface RuntimePostgresPool extends PostgresPool {
  end(): Promise<void>;
}

/** Create the only approved PostgreSQL driver boundary for the production adapter. */
export function createPostgresPool(options: PostgresRuntimeOptions = {}, env: NodeJS.ProcessEnv = process.env): RuntimePostgresPool {
  const resolved = resolvePostgresRuntimeOptions(options, env);
  const pool = new Pool(asPoolConfig(resolved));
  const onPoolError = options.onPoolError ?? ((error: { name: string; code?: string }) => {
    // Do not log the driver message: it may contain a host, SQL fragment or
    // connection detail. The deployment logger should attach the redacted code.
    console.error('postgres pool error', error.name, error.code ?? 'unknown');
  });
  pool.on('error', (error: Error & { code?: string }) => onPoolError({ name: error.name, ...(error.code ? { code: error.code } : {}) }));
  return pool as RuntimePostgresPool;
}

/**
 * Probe connectivity without selecting student-owned rows. RLS readiness is
 * checked separately by `NormalizedPostgresStateRepository.healthCheck()`.
 */
export async function probePostgresPool(pool: PostgresPool): Promise<{ connected: true }> {
  const client = await pool.connect();
  try {
    await client.query('select 1');
    return { connected: true };
  } finally {
    client.release();
  }
}

/** Test-only adapter helper that keeps the driver result shape explicit. */
export type RuntimeQueryResult<Row = unknown> = QueryResult<Row>;

export type RuntimePostgresClient = PostgresPoolClient;
