import { seedDemoState } from '../dist/apps/api/src/domain/seed.js';
import { JsonStore } from '../dist/apps/api/src/domain/store.js';
import {
  acknowledgeCase,
  addFollowUp,
  approveClosure,
  assignCase,
  createRiskSignal,
  drainOutbox,
  escalateUnacknowledged,
  requeueDeadLetters,
  requestClosure,
  reviewCase,
} from '../dist/apps/api/src/domain/service.js';

function authFor(state, userId) {
  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) throw new Error(`synthetic user missing: ${userId}`);
  return { user, session: { tokenHash: `drill-${userId}`, userId, tenantId: user.tenantId, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() } };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const store = new JsonStore({ initial: seedDemoState() });
const studentAuth = authFor(store.snapshot(), 'student-demo');
const opsAuth = authFor(store.snapshot(), 'user-ops-demo');
const leadAuth = authFor(store.snapshot(), 'user-professional-demo');
const counselorAuth = authFor(store.snapshot(), 'user-counselor-demo');

// A self-help signal must remain visible for a person to acknowledge; delivery
// and escalation never mutate the case into a clinical conclusion themselves.
const riskCase = await createRiskSignal(store, studentAuth, { studentId: 'student-demo', level: 'urgent', reason: '合成演示：学生主动申请紧急人工支持' });
const initialState = store.snapshot();
assert(initialState.riskCases.find((candidate) => candidate.id === riskCase.id)?.state === 'pending_review', 'urgent case was not queued for review');
await store.transaction((state) => {
  const current = state.riskCases.find((candidate) => candidate.id === riskCase.id);
  if (current) current.updatedAt = '2020-01-01T00:00:00.000Z';
});
const escalation = await escalateUnacknowledged(store, opsAuth, { asOf: '2026-09-11T00:00:00.000Z', thresholdMinutes: 30 });
const delivery = await drainOutbox(store, 50);
const deliveredState = store.snapshot();
assert(escalation.escalated === 1, 'unacknowledged urgent case was not escalated');
assert(delivery.processed >= 2, 'urgent and escalation events were not delivered');
assert(deliveredState.riskCases.find((candidate) => candidate.id === riskCase.id)?.state === 'pending_review', 'worker delivery auto-closed the case');
assert(deliveredState.deliveryAttempts.filter((attempt) => attempt.status === 'sent').length >= 2, 'urgent and escalation deliveries were not recorded');

// Only the professional workflow can review, assign, acknowledge, and close.
await reviewCase(store, leadAuth, riskCase.id, { decision: 'confirm', note: '合成演示：专业复核确认需要人工支持' });
await assignCase(store, leadAuth, riskCase.id, counselorAuth.user.id);
await acknowledgeCase(store, counselorAuth, riskCase.id);
await addFollowUp(store, counselorAuth, riskCase.id, { kind: 'referral', note: '合成演示：记录支持与转介路径', dueAt: '2026-09-12T00:00:00.000Z' });
await requestClosure(store, counselorAuth, riskCase.id, '合成演示：完成支持后申请独立结案复核');
assert(store.snapshot().riskCases.find((candidate) => candidate.id === riskCase.id)?.state === 'closure_requested', 'closure was not held for independent approval');
await approveClosure(store, leadAuth, riskCase.id);
assert(store.snapshot().riskCases.find((candidate) => candidate.id === riskCase.id)?.state === 'closed', 'independent closure did not complete');

// Simulate a broken queue reference, then repair it through the operations
// dead-letter path. This proves a retry can recover without silently dropping
// an urgent notification; it is not a substitute for a real on-call exercise.
await store.transaction((state) => {
  state.outboxEvents.push({ id: 'crisis-drill-broken-event', tenantId: 'tenant-demo', type: 'risk.escalation', aggregateId: 'crisis-drill-recovery-case', payload: { caseId: 'crisis-drill-recovery-case', reason: 'synthetic_fault' }, status: 'pending', attempts: 4, availableAt: new Date().toISOString(), createdAt: new Date().toISOString() });
});
const failed = await drainOutbox(store, 1);
assert(failed.failed === 1, 'broken queue reference did not fail visibly');
assert(store.snapshot().outboxEvents.find((event) => event.id === 'crisis-drill-broken-event')?.status === 'dead_letter', 'failed queue event was not isolated as dead letter');
await store.transaction((state) => {
  state.riskCases.push({ id: 'crisis-drill-recovery-case', tenantId: 'tenant-demo', studentId: 'student-demo', state: 'pending_review', priority: 'urgent', signalIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
});
const requeued = await requeueDeadLetters(store, opsAuth, 1);
const recovered = await drainOutbox(store, 1);
const finalState = store.snapshot();
const repairedEvent = finalState.outboxEvents.find((event) => event.id === 'crisis-drill-broken-event');
assert(requeued.requeued === 1 && recovered.processed === 1 && repairedEvent?.status === 'published', 'dead-letter event did not recover after repair');

console.log(JSON.stringify({
  status: 'ok',
  scope: 'synthetic-crisis-and-fault-continuity',
  urgentCase: { initial: initialState.riskCases.find((candidate) => candidate.id === riskCase.id)?.state, afterDelivery: deliveredState.riskCases.find((candidate) => candidate.id === riskCase.id)?.state, afterHumanClosure: finalState.riskCases.find((candidate) => candidate.id === riskCase.id)?.state },
  escalation: { queued: escalation.escalated, sentDeliveries: deliveredState.deliveryAttempts.filter((attempt) => attempt.status === 'sent').length },
  workerFailure: { failed: failed.failed, deadLettered: true, requeued: requeued.requeued, recovered: recovered.processed },
  noAutomaticClosure: true,
  note: '合成演练不代表真实值班、通知供应商或危机处置能力。',
}));
