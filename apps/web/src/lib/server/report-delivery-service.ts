import { createHash } from 'node:crypto';
import { buildReportDocument, renderReportPdf, type ReportLocale } from '@masters/domain';
import {
  appendReportVersion,
  getNextReportVersionNumber,
  getReportGenerationSource,
  getReportVersion,
  type Database,
  type StoredReportVersion,
} from '@masters/db';
import {
  createReportArtifactStorage,
  type ReportArtifactStorage,
} from '@/lib/report-artifact-storage';

function thresholdWatts(json: string): number | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    for (const key of ['watts', 'powerWatts', 'thresholdWatts']) {
      if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Math.round(record[key]);
    }
    for (const key of ['wattsX100', 'powerWattsX100']) {
      if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Math.round(record[key] / 100);
    }
    return null;
  } catch {
    return null;
  }
}

function scopedSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`${label} is not safe for report storage`);
  return value;
}

function storageReference(tenantId: string, testId: string, locale: ReportLocale, version: number): string {
  return `${scopedSegment(tenantId, 'Tenant ID')}/${scopedSegment(testId, 'Test ID')}/${locale}/v${version}.pdf`;
}

function hashPdf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export interface GeneratedReportVersion {
  readonly version: StoredReportVersion;
  readonly downloadPath: string;
}

export function createReportDeliveryService(db: Database, storage: ReportArtifactStorage) {
  return {
    async generate(tenantId: string, testId: string, locale: ReportLocale): Promise<GeneratedReportVersion> {
      const source = await getReportGenerationSource(db, tenantId, testId);
      if (!source) throw new Error('Released interpretation not found for tenant test');
      const nextVersion = await getNextReportVersionNumber(db, tenantId, testId, locale);
      const document = buildReportDocument(locale, {
        athleteName: source.athleteName,
        testDate: source.testDate,
        trainerName: source.trainerName,
        tenantName: source.tenantName,
        deviceType: source.deviceType,
        protocolVersion: source.protocolVersion,
        reportVersion: nextVersion,
        releasedAt: source.releasedAt,
        lt1Watts: thresholdWatts(source.lt1Json),
        lt2Watts: thresholdWatts(source.lt2Json),
        trainerComment: source.trainerComment,
      });
      const pdf = renderReportPdf(document);
      const reference = storageReference(tenantId, testId, locale, nextVersion);
      await storage.put(reference, pdf);
      try {
        const version = await appendReportVersion(db, tenantId, testId, {
          interpretationId: source.interpretationId,
          locale,
          contentHash: hashPdf(pdf),
          storageReference: reference,
        });
        if (version.versionNumber !== nextVersion) {
          throw new Error('Report version changed during generation');
        }
        return Object.freeze({
          version,
          downloadPath: `/api/tests/${testId}/reports/${version.id}`,
        });
      } catch (error) {
        await storage.remove(reference);
        throw error;
      }
    },

    async download(tenantId: string, testId: string, reportVersionId: string) {
      const version = await getReportVersion(db, tenantId, testId, reportVersionId);
      if (!version) return null;
      const bytes = await storage.get(version.storageReference);
      if (hashPdf(bytes) !== version.contentHash) {
        throw new Error('Stored report artifact hash mismatch');
      }
      return Object.freeze({ version, bytes });
    },
  };
}

export function createDatabaseReportDeliveryService(db: Database) {
  return createReportDeliveryService(db, createReportArtifactStorage());
}
