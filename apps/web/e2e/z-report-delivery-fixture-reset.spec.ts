import { test } from '@playwright/test';
import { db } from '../src/lib/db';

test('restores the shared data-review fixture after report delivery verification', async () => {
  const now = new Date().toISOString();
  await db.$client.execute({
    sql: `UPDATE tests
      SET status = 'DATA_REVIEW', released_at = NULL, updated_at = ?
      WHERE status = 'RELEASED'
        AND athlete_id IN (
          SELECT id FROM athletes WHERE first_name = 'Max' AND last_name = 'Test'
        )`,
    args: [now],
  });
});
