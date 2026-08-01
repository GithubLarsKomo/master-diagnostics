import { describe, expect, it } from 'vitest';
import { deriveAthleteDashboardSummary } from '../src/athlete-dashboard';

describe('deriveAthleteDashboardSummary', () => {
  it('summarizes athlete test workflow states and latest test', () => {
    const summary = deriveAthleteDashboardSummary([
      { testId: 'old', status: 'RELEASED', createdAt: '2026-01-01T10:00:00.000Z', expectedLt2Watts: 300, startWatts: 180, incrementWatts: 30, maximumStages: 7 },
      { testId: 'review', status: 'DATA_REVIEW', createdAt: '2026-07-01T10:00:00.000Z', expectedLt2Watts: 320, startWatts: 190, incrementWatts: 30, maximumStages: 7 },
      { testId: 'current', status: 'IN_PROGRESS', createdAt: '2026-08-01T10:00:00.000Z', expectedLt2Watts: 340, startWatts: 205, incrementWatts: 35, maximumStages: 7 },
    ]);

    expect(summary).toEqual({
      totalTests: 3,
      activeTests: 1,
      reviewTests: 1,
      completedTests: 1,
      latestTestAt: '2026-08-01T10:00:00.000Z',
    });
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it('returns an immutable empty summary', () => {
    const summary = deriveAthleteDashboardSummary([]);
    expect(summary).toEqual({ totalTests: 0, activeTests: 0, reviewTests: 0, completedTests: 0, latestTestAt: null });
    expect(Object.isFrozen(summary)).toBe(true);
  });
});
