/**
 * PostgreSQL connection-pool boundary used by the future production adapter.
 *
 * The domain layer receives a Store implementation, but every SQL transaction
 * must establish the tenant context on the leased connection before any query.
 * This module deliberately depends on the small `query`/`connect` shape rather
 * than importing a driver, so the adapter can use the approved PostgreSQL
 * client version without pulling infrastructure into the reference build.
 */

export interface QueryResult<Row = unknown> { rows: Row[]; }

export interface PostgresClient {
  query<Row = unknown>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface PostgresPoolClient extends PostgresClient {
  release(error?: Error): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresPoolClient>;
}

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 128 || /[\0\r\n]/.test(tenantId)) {
    throw new Error('TENANT_CONTEXT_INVALID');
  }
}

/**
 * Run work with a transaction-local tenant setting. `set_config(..., true)` is
 * PostgreSQL's parameterized equivalent of `SET LOCAL`, and avoids building
 * SQL from an untrusted tenant identifier. ROLLBACK is attempted on every
 * failure so a pooled connection cannot retain a tenant context.
 */
export async function withTenantTransaction<T>(client: PostgresClient, tenantId: string, work: (client: PostgresClient) => Promise<T>): Promise<T> {
  assertTenantId(tenantId);
  await client.query('BEGIN');
  try {
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

/** Lease and release a pool connection around the tenant-scoped transaction. */
export async function withTenantPoolTransaction<T>(pool: PostgresPool, tenantId: string, work: (client: PostgresClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let released = false;
  const release = (error?: Error) => {
    if (released) return;
    released = true;
    client.release(error);
  };
  try {
    return await withTenantTransaction(client, tenantId, work);
  } catch (error) {
    release(error instanceof Error ? error : new Error('TENANT_TRANSACTION_FAILED'));
    throw error;
  } finally {
    release();
  }
}
