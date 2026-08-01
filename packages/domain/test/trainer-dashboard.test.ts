import { describe, expect, it } from 'vitest';
import {
  deriveTrainerDashboardSummary,
  deriveTrainerDashboardTasks,
} from '../src/trainer-dashboard';

describe('deriveTrainerDashboardTasks', () => {
  it('keeps only actionable trainer tasks and orders them by urgency', () => {
    const tasks = deriveTrainerDashboardTasks([
      { testId: 'planned-b', athleteName: 'Berta Beispiel', status: 'PLANNED' },
      { testId: 'released', athleteName: 'Rita Release', status: 'RELEASED' },
      { testId: 'review', athleteName: 'Dora Daten', status: 'DATA_REVIEW' },
      { testId: 'running', athleteName: 'Ingo Imtest', status: 'IN_PROGRESS' },
      { testId: 'planned-a', athleteName: 'Anna Anfang', status: 'PLANNED' },
    ]);

    expect(tasks.map((task) => task.kind)).toEqual([
      'CONTINUE_TEST',
      'REVIEW_DATA',
      'PREPARE_TEST',
      'PREPARE_TEST',
    ]);
    expect(tasks.map((task) => task.testId)).toEqual([
      'running',
      'review',
      'planned-a',
      'planned-b',
    ]);
    expect(tasks[0]?.href).toBe('/tests/running');
  });

  it('returns deeply immutable task objects', () => {
    const tasks = deriveTrainerDashboardTasks([
      { testId: 'running', athleteName: 'Ingo Imtest', status: 'IN_PROGRESS' },
    ]);

    expect(Object.isFrozen(tasks)).toBe(true);
    expect(Object.isFrozen(tasks[0])).toBe(true);
  });
});

describe('deriveTrainerDashboardSummary', () => {
  it('counts actionable tasks by workflow kind', () => {
    const tasks = deriveTrainerDashboardTasks([
      { testId: 'running', athleteName: 'Ingo Imtest', status: 'IN_PROGRESS' },
      { testId: 'review', athleteName: 'Dora Daten', status: 'DATA_REVIEW' },
      { testId: 'planned-a', athleteName: 'Anna Anfang', status: 'PLANNED' },
      { testId: 'planned-b', athleteName: 'Berta Beispiel', status: 'PLANNED' },
    ]);

    expect(deriveTrainerDashboardSummary(tasks)).toEqual({
      total: 4,
      continueTests: 1,
      reviewData: 1,
      prepareTests: 2,
    });
  });

  it('returns an immutable empty summary', () => {
    const summary = deriveTrainerDashboardSummary([]);
    expect(summary).toEqual({
      total: 0,
      continueTests: 0,
      reviewData: 0,
      prepareTests: 0,
    });
    expect(Object.isFrozen(summary)).toBe(true);
  });
});
