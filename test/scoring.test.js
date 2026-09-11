import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score, assertUsableScale } from '../dist/apps/api/src/domain/scoring.js';

const scale = {
  id: 'gold-scale', tenantId: 'tenant', code: 'SYNTH-GOLD', title: '合成计分金标准', version: '1.0.0', provenance: 'synthetic_only', status: 'approved', minAge: 12, maxAge: 18, scoringVersion: 'gold-v1', noticeVersion: 'notice',
  items: [
    { id: 'normal', prompt: 'x', min: 0, max: 3, reverse: false, factor: 'a' },
    { id: 'reverse', prompt: 'y', min: 0, max: 3, reverse: true, factor: 'a' },
    { id: 'factor-b', prompt: 'z', min: 0, max: 1, reverse: false, factor: 'b' },
  ],
};

test('independent scoring golden vectors cover reverse, factors and exact total', () => {
  const output = score(scale, { normal: 2, reverse: 1, 'factor-b': 1 });
  // Expected values are hand-calculated from the scale contract, not copied from the implementation.
  assert.deepEqual(output, { factorScores: { a: 4, b: 1 }, total: 5, validity: 'valid' });
});

test('invalid answer vectors never become a normal result', () => {
  assert.equal(score(scale, { normal: 2, reverse: 1 }).validity, 'invalid');
  assert.equal(score(scale, { normal: 4, reverse: 1, 'factor-b': 1 }).validity, 'invalid');
  assert.equal(score(scale, { normal: 2, reverse: 1, 'factor-b': 2 }).validity, 'invalid');
});

test('synthetic scales are barred only in production mode', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => assertUsableScale(scale), /演示量表/);
  process.env.NODE_ENV = previous;
});
