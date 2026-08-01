import type { TestStatus } from './test-status';

export type TrainerDashboardTaskKind = 'CONTINUE_TEST' | 'REVIEW_DATA' | 'PREPARE_TEST';

export interface TrainerDashboardTestInput {
  readonly testId: string;
  readonly athleteName: string;
  readonly status: TestStatus;
}

export interface TrainerDashboardTask {
  readonly testId: string;
  readonly athleteName: string;
  readonly kind: TrainerDashboardTaskKind;
  readonly priority: number;
  readonly label: string;
  readonly href: string;
}

export interface TrainerDashboardSummary {
  readonly total: number;
  readonly continueTests: number;
  readonly reviewData: number;
  readonly prepareTests: number;
}

const taskByStatus: Partial<Record<TestStatus, Omit<TrainerDashboardTask, 'testId' | 'athleteName' | 'href'>>> = {
  IN_PROGRESS: {
    kind: 'CONTINUE_TEST',
    priority: 0,
    label: 'Laufenden Test fortsetzen',
  },
  DATA_REVIEW: {
    kind: 'REVIEW_DATA',
    priority: 1,
    label: 'Testdaten prüfen und auswerten',
  },
  PLANNED: {
    kind: 'PREPARE_TEST',
    priority: 2,
    label: 'Geplanten Test vorbereiten',
  },
};

export function deriveTrainerDashboardTasks(
  tests: readonly TrainerDashboardTestInput[],
): readonly TrainerDashboardTask[] {
  const tasks = tests.flatMap((test) => {
    const template = taskByStatus[test.status];
    if (!template) return [];

    return [{
      ...template,
      testId: test.testId,
      athleteName: test.athleteName.trim(),
      href: `/tests/${test.testId}`,
    }];
  });

  tasks.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    const athleteOrder = left.athleteName.localeCompare(right.athleteName, 'de');
    if (athleteOrder !== 0) return athleteOrder;
    return left.testId.localeCompare(right.testId);
  });

  return Object.freeze(tasks.map((task) => Object.freeze(task)));
}

export function deriveTrainerDashboardSummary(
  tasks: readonly TrainerDashboardTask[],
): TrainerDashboardSummary {
  const summary: TrainerDashboardSummary = {
    total: tasks.length,
    continueTests: tasks.filter((task) => task.kind === 'CONTINUE_TEST').length,
    reviewData: tasks.filter((task) => task.kind === 'REVIEW_DATA').length,
    prepareTests: tasks.filter((task) => task.kind === 'PREPARE_TEST').length,
  };
  return Object.freeze(summary);
}
