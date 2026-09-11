import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../dist/apps/api/src/main.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import { seedDemoState } from '../dist/apps/api/src/domain/seed.js';

process.env.CAMPMIND_DEMO_MFA = 'true';
process.env.CAMPMIND_MASTER_KEY = 'test-master-key-never-use-in-production';

let server;
let base;

before(async () => {
  server = createApp({ store: new JsonStore({ initial: seedDemoState() }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('login rate limit exposes bounded headers and a retry response', async () => {
  const responses = [];
  for (let index = 0; index < 21; index += 1) {
    responses.push(await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  }
  const first = responses[0];
  const limited = responses.at(-1);
  assert.equal(first.status, 400);
  assert.equal(first.headers.get('x-ratelimit-limit'), '20');
  assert.equal(first.headers.get('x-ratelimit-remaining'), '19');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('x-ratelimit-limit'), '20');
  assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  const payload = await limited.json();
  assert.equal(payload.error.code, 'RATE_LIMITED');
});
