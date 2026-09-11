import { performance } from 'node:perf_hooks';
import { createApp } from '../dist/apps/api/src/main.js';
import { seedDemoState, DEMO_PASSWORD } from '../dist/apps/api/src/domain/seed.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';

/**
 * Bounded local capacity baseline.  It deliberately uses only the synthetic
 * store and read paths; production targets must be supplied and signed off by
 * the deployment owner rather than inferred from this laptop run.
 */
const requests = Number(process.env.CAPACITY_REQUESTS ?? 120);
const concurrency = Number(process.env.CAPACITY_CONCURRENCY ?? 20);
const targetP95 = process.env.CAPACITY_P95_TARGET_MS ? Number(process.env.CAPACITY_P95_TARGET_MS) : undefined;
if (!Number.isInteger(requests) || requests < 1 || requests > 2_000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > requests) {
  throw new Error('CAPACITY_REQUESTS/CAPACITY_CONCURRENCY must be bounded positive integers');
}
if (targetP95 !== undefined && (!Number.isFinite(targetP95) || targetP95 <= 0)) throw new Error('CAPACITY_P95_TARGET_MS must be positive');

process.env.CAMPMIND_DEMO_MFA = 'true';
const store = new JsonStore({ initial: seedDemoState() });
const server = createApp({ store });
await new Promise((resolve) => server.listen(0, resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
try {
  const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'student@campus-mind.demo', password: DEMO_PASSWORD }) });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { data } = await login.json();
  const durations = [];
  let completed = 0;
  let errors = 0;
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= requests) return;
      const started = performance.now();
      try {
        const path = index % 2 === 0 ? '/health' : '/v1/me/tasks';
        const response = await fetch(`${base}${path}`, { headers: path === '/health' ? undefined : { authorization: `Bearer ${data.token}` } });
        if (!response.ok) errors += 1; else completed += 1;
        await response.arrayBuffer();
      } catch {
        errors += 1;
      } finally {
        durations.push(performance.now() - started);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  durations.sort((a, b) => a - b);
  const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] ?? 0;
  const result = {
    status: errors === 0 && (targetP95 === undefined || percentile(0.95) <= targetP95) ? 'ok' : 'degraded',
    scope: 'synthetic-local-json',
    requests,
    concurrency,
    completed,
    errors,
    errorRate: requests === 0 ? 0 : errors / requests,
    p50Ms: Number(percentile(0.50).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number((durations.at(-1) ?? 0).toFixed(2)),
    targetP95Ms: targetP95 ?? null,
    targetMet: targetP95 === undefined ? null : percentile(0.95) <= targetP95,
    note: '本地合成基线不代表生产容量、RPO/RTO 或供应商 SLA。',
  };
  console.log(JSON.stringify(result));
  if (result.status !== 'ok') process.exitCode = 2;
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
