import type { TestStatus } from './test-status';

export interface AthleteDashboardTestInput {
  readonly testId: string;
  readonly status: TestStatus;
  readonly createdAt: string;
  readonly expectedLt2Watts: number;
  readonly startWatts: number;
  readonly incrementWatts: number;
  readonly maximumStages: number;
}

export interface AthleteDashboardSummary {
  readonly totalTests: number;
  readonly activeTests: number;
  readonly reviewTests: number;
  readonly completedTests: number;
  readonly latestTestAt: string | null;
}

export function deriveAthleteDashboardSummary(
  tests: readonly AthleteDashboardTestInput[],
): AthleteDashboardSummary {
  const summary: AthleteDashboardSummary = {
    totalTests: tests.length,
    activeTests: tests.filter((test) => test.status === 'PLANNED' || test.status === 'IN_PROGRESS').length,
    reviewTests: tests.filter((test) => test.status === 'DATA_REVIEW').length,
    completedTests: tests.filter((test) => test.status === 'RELEASED').length,
    latestTestAt: tests.length === 0
      ? null
      : [...tests].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.createdAt ?? null,
  };

  return Object.freeze(summary);
}
