import { describe, expect, it } from 'vitest';
import { canTransition, type TestStatus } from '../src/test-status';

describe('test lifecycle transitions', () => {
  it('allows the guarded execution path in order', () => {
    const path: TestStatus[] = [
      'PLANNED',
      'IN_PROGRESS',
      'DATA_REVIEW',
      'INTERPRETED',
      'RELEASED',
      'ARCHIVED',
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it('rejects duplicate, reverse and post-archive transitions', () => {
    expect(canTransition('PLANNED', 'PLANNED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'PLANNED')).toBe(false);
    expect(canTransition('RELEASED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('ARCHIVED', 'PLANNED')).toBe(false);
  });
});
