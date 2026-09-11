import { DomainError } from './errors.js';
import type { ScaleVersion } from './types.js';

export interface ScoreOutput {
  factorScores: Record<string, number>;
  total: number;
  validity: 'valid' | 'invalid';
  invalidReason?: string;
}

/** Deterministic reference scorer. Only explicitly approved scale versions may reach this function. */
export function score(scale: ScaleVersion, answers: Record<string, unknown>): ScoreOutput {
  const factorScores: Record<string, number> = {};
  let total = 0;
  let answered = 0;
  for (const item of scale.items) {
    const raw = answers[item.id];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < item.min || raw > item.max) {
      continue;
    }
    const value = item.reverse ? item.max - raw + item.min : raw;
    factorScores[item.factor] = (factorScores[item.factor] ?? 0) + value;
    total += value;
    answered += 1;
  }
  if (answered !== scale.items.length) {
    return { factorScores, total, validity: 'invalid', invalidReason: 'ANSWER_SET_INCOMPLETE_OR_OUT_OF_RANGE' };
  }
  return { factorScores, total, validity: 'valid' };
}

export function assertUsableScale(scale: ScaleVersion, now = new Date()): void {
  if (scale.status !== 'approved') throw new DomainError('SCALE_NOT_APPROVED', '测评方案尚未通过专业审定');
  if (scale.provenance === 'synthetic_only' && process.env.NODE_ENV === 'production') {
    throw new DomainError('SYNTHETIC_SCALE_BLOCKED', '演示量表不能用于生产测评');
  }
  if (scale.licenseExpiresAt && new Date(scale.licenseExpiresAt) <= now) {
    throw new DomainError('LICENSE_EXPIRED', '量表授权已到期，不能开始新的测评');
  }
  if (scale.minAge < 6 || scale.maxAge > 19 || scale.minAge > scale.maxAge) {
    throw new DomainError('SCALE_AGE_INVALID', '测评方案年龄范围无效');
  }
  void now;
}
