import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDatabase } from './client';
import { cleanupUnavailableAthleteDataSubjectDeliveryPackages } from './services/data-subject-delivery-cleanup';

const SAFE_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;
const rootDirectory = resolve(
  process.env.DATA_SUBJECT_DELIVERY_PACKAGE_ROOT ?? '../../.data/data-subject-delivery-packages',
);
const assessedAt = process.env.DATA_SUBJECT_DELIVERY_CLEANUP_NOW ?? new Date().toISOString();
const db = createDatabase();

const summary = await cleanupUnavailableAthleteDataSubjectDeliveryPackages(db, {
  async remove(reference: string) {
    if (!SAFE_REFERENCE.test(reference)) {
      throw new Error(`Unsafe data subject delivery storage reference: ${reference}`);
    }
    await rm(join(rootDirectory, reference), { force: true });
  },
}, assessedAt);

console.log(JSON.stringify(summary));
