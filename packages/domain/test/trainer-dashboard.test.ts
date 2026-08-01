import { describe, expect, it } from 'vitest';
import { deriveTrainerDashboardTasks } from '../src/trainer-dashboard';

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
