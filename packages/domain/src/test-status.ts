export type TestStatus =
  | 'PLANNED'
  | 'IN_PROGRESS'
  | 'DATA_REVIEW'
  | 'INTERPRETED'
  | 'RELEASED'
  | 'ARCHIVED';

const transitions: Record<TestStatus, readonly TestStatus[]> = {
  PLANNED: ['IN_PROGRESS', 'ARCHIVED'],
  IN_PROGRESS: ['DATA_REVIEW', 'ARCHIVED'],
  DATA_REVIEW: ['INTERPRETED', 'ARCHIVED'],
  INTERPRETED: ['DATA_REVIEW', 'RELEASED', 'ARCHIVED'],
  RELEASED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransition(from: TestStatus, to: TestStatus): boolean {
  return transitions[from].includes(to);
}
