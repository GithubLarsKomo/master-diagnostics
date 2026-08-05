import type {
  QuarantinableDataSubjectDeliveryPackageStorage,
  StagedDataSubjectDeliveryPackage,
} from '@/lib/data-subject-delivery-package-storage';
import type {
  QuarantinableReportArtifactStorage,
  StagedReportArtifact,
} from '@/lib/report-artifact-storage';
import type {
  QuarantinableTenantExportPackageStorage,
  StagedTenantExportPackage,
} from '@/lib/tenant-export-package-storage';

export interface StagedAnonymizationArtifacts {
  executionId: string;
  reports: ReadonlyArray<Readonly<StagedReportArtifact>>;
  tenantExports: ReadonlyArray<Readonly<StagedTenantExportPackage>>;
  dataSubjectExports: ReadonlyArray<Readonly<StagedDataSubjectDeliveryPackage>>;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

async function restoreBestEffort(
  staged: Readonly<StagedAnonymizationArtifacts>,
  reportStorage: QuarantinableReportArtifactStorage,
  exportStorage: QuarantinableTenantExportPackageStorage,
  dataSubjectStorage: QuarantinableDataSubjectDeliveryPackageStorage,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const handle of [...staged.dataSubjectExports].reverse()) {
    try {
      await dataSubjectStorage.restoreStaged(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const handle of [...staged.tenantExports].reverse()) {
    try {
      await exportStorage.restoreStaged(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const handle of [...staged.reports].reverse()) {
    try {
      await reportStorage.restoreStaged(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Moves every currently referenced report/export artifact into an execution-
 * scoped quarantine. If any stage operation fails, already staged artifacts are
 * restored before the error is returned. No DB rows are changed here.
 */
export async function stageAnonymizationArtifacts(
  executionId: string,
  reportReferences: readonly string[],
  tenantExportReferences: readonly string[],
  dataSubjectExportReferences: readonly string[],
  reportStorage: QuarantinableReportArtifactStorage,
  exportStorage: QuarantinableTenantExportPackageStorage,
  dataSubjectStorage: QuarantinableDataSubjectDeliveryPackageStorage,
): Promise<Readonly<StagedAnonymizationArtifacts>> {
  const reports: Readonly<StagedReportArtifact>[] = [];
  const tenantExports: Readonly<StagedTenantExportPackage>[] = [];
  const dataSubjectExports: Readonly<StagedDataSubjectDeliveryPackage>[] = [];

  try {
    for (const reference of uniqueSorted(reportReferences)) {
      reports.push(await reportStorage.stageForDeletion(executionId, reference));
    }
    for (const reference of uniqueSorted(tenantExportReferences)) {
      tenantExports.push(await exportStorage.stageForDeletion(executionId, reference));
    }
    for (const reference of uniqueSorted(dataSubjectExportReferences)) {
      dataSubjectExports.push(await dataSubjectStorage.stageForDeletion(executionId, reference));
    }
  } catch (stageError) {
    const staged = Object.freeze({
      executionId,
      reports: Object.freeze([...reports]),
      tenantExports: Object.freeze([...tenantExports]),
      dataSubjectExports: Object.freeze([...dataSubjectExports]),
    });
    const rollbackErrors = await restoreBestEffort(
      staged,
      reportStorage,
      exportStorage,
      dataSubjectStorage,
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [stageError, ...rollbackErrors],
        'Anonymization artifact staging failed and rollback was incomplete',
      );
    }
    throw stageError;
  }

  return Object.freeze({
    executionId,
    reports: Object.freeze([...reports]),
    tenantExports: Object.freeze([...tenantExports]),
    dataSubjectExports: Object.freeze([...dataSubjectExports]),
  });
}

/** Restores all staged artifacts when the database commit has not happened. */
export async function restoreAnonymizationArtifacts(
  staged: Readonly<StagedAnonymizationArtifacts>,
  reportStorage: QuarantinableReportArtifactStorage,
  exportStorage: QuarantinableTenantExportPackageStorage,
  dataSubjectStorage: QuarantinableDataSubjectDeliveryPackageStorage,
): Promise<void> {
  const errors = await restoreBestEffort(staged, reportStorage, exportStorage, dataSubjectStorage);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Anonymization artifact restore was incomplete');
  }
}

/**
 * Permanently removes quarantined artifacts after the database commit is
 * durable. A failed purge is retryable because the handles remain stable.
 */
export async function purgeAnonymizationArtifacts(
  staged: Readonly<StagedAnonymizationArtifacts>,
  reportStorage: QuarantinableReportArtifactStorage,
  exportStorage: QuarantinableTenantExportPackageStorage,
  dataSubjectStorage: QuarantinableDataSubjectDeliveryPackageStorage,
): Promise<void> {
  const errors: unknown[] = [];
  for (const handle of staged.reports) {
    try {
      await reportStorage.purgeStaged(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const handle of staged.tenantExports) {
    try {
      await exportStorage.purgeStaged(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const handle of staged.dataSubjectExports) {
    try {
      await dataSubjectStorage.purgeStaged(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Anonymization artifact purge was incomplete');
  }
}
