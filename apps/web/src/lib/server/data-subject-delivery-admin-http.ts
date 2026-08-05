import type { AuditActorContext } from '@masters/db';
import type { CreatedDataSubjectDeliveryPackage } from './data-subject-delivery-package-writer';

export interface DataSubjectDeliveryAdminContext extends AuditActorContext {
  tenantId: string;
}

export interface DataSubjectDeliveryAdminHttpDependencies {
  verifyPassword(password: string): Promise<boolean>;
  validateApproval(
    tenantId: string,
    athleteId: string,
    approvalId: string,
  ): Promise<Readonly<{ validForDeliveryPackaging: boolean }>>;
  createPackage(input: Readonly<{
    tenantId: string;
    athleteId: string;
    approvalId: string;
    actor: AuditActorContext;
  }>): Promise<Readonly<CreatedDataSubjectDeliveryPackage>>;
}

interface CreateRequest {
  password: string;
  athleteId: string;
  approvalId: string;
}

const MAX_IDENTIFIER_LENGTH = 128;

function secureJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function nonEmptyIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  return trimmed;
}

async function parseCreateRequest(request: Request): Promise<CreateRequest | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const password = typeof record.password === 'string' && record.password.length > 0
    ? record.password
    : null;
  const athleteId = nonEmptyIdentifier(record.athleteId);
  const approvalId = nonEmptyIdentifier(record.approvalId);
  if (!password || !athleteId || !approvalId) return null;
  return { password, athleteId, approvalId };
}

/**
 * Administrative HTTP boundary for creating a single encrypted subject-data
 * package. The returned bearer token is intentionally never embedded in a URL.
 */
export async function serveDataSubjectDeliveryPackageCreation(
  request: Request,
  context: Readonly<DataSubjectDeliveryAdminContext>,
  deps: DataSubjectDeliveryAdminHttpDependencies,
): Promise<Response> {
  if (context.role !== 'TENANT_ADMIN') {
    return secureJson({ error: 'DATA_SUBJECT_EXPORT_FORBIDDEN' }, 403);
  }

  const input = await parseCreateRequest(request);
  if (!input) return secureJson({ error: 'DATA_SUBJECT_EXPORT_REQUEST_INVALID' }, 400);

  let passwordValid = false;
  try {
    passwordValid = await deps.verifyPassword(input.password);
  } catch {
    passwordValid = false;
  }
  if (!passwordValid) {
    return secureJson({ error: 'DATA_SUBJECT_EXPORT_REAUTHENTICATION_FAILED' }, 401);
  }

  const currentApproval = await deps.validateApproval(context.tenantId, input.athleteId, input.approvalId);
  if (!currentApproval.validForDeliveryPackaging) {
    return secureJson({ error: 'DATA_SUBJECT_EXPORT_APPROVAL_NOT_CURRENT' }, 409);
  }

  let created: Readonly<CreatedDataSubjectDeliveryPackage>;
  try {
    created = await deps.createPackage({
      tenantId: context.tenantId,
      athleteId: input.athleteId,
      approvalId: input.approvalId,
      actor: context,
    });
  } catch {
    const revalidated = await deps.validateApproval(context.tenantId, input.athleteId, input.approvalId)
      .catch(() => null);
    if (revalidated && !revalidated.validForDeliveryPackaging) {
      return secureJson({ error: 'DATA_SUBJECT_EXPORT_APPROVAL_NOT_CURRENT' }, 409);
    }
    return secureJson({ error: 'DATA_SUBJECT_EXPORT_PACKAGE_CREATION_FAILED' }, 500);
  }

  return secureJson({
    packageId: created.record.id,
    expiresAt: created.record.expiresAt,
    manifestFingerprint: created.record.manifestFingerprint,
    packageSha256: created.record.packageSha256,
    downloadEndpoint: new URL('/api/data-subject/export/download', request.url).toString(),
    tokenType: 'Bearer',
    downloadToken: created.token,
  }, 201);
}
