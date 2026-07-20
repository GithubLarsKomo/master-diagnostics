import { describe, expect, it } from 'vitest';
import { planFromExpectedLt2 } from '../src/protocol-planning';

describe('planFromExpectedLt2', () => {
  it('places expected LT2 around stage five', () => {
    const plan = planFromExpectedLt2(350, 8);
    expect(plan.startWatts).toBe(210);
    expect(plan.incrementWatts).toBe(35);
    expect(plan.stages[4]).toBe(350);
  });
});
