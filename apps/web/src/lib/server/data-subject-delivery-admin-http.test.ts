import { describe, expect, it, vi } from 'vitest';
import { serveDataSubjectDeliveryPackageCreation } from './data-subject-delivery-admin-http';

const context = {
  tenantId: 'tenant-a',
  userId: 'admin-a',
  role: 'TENANT_ADMIN' as const,
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'session-a',
};

function request(body: unknown): Request {
  return new Request('https://diagnostics.example.test/api/data-subject/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createdPackage() {
  return {
    record: {
      id: '123e4567-e89b-12d3-a456-426614174000',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      approvalId: 'approval-a',
      packageVersion: 1 as const,
      manifestFingerprint: `sha256:${'a'.repeat(64)}`,
      tokenHash: `sha256:${'b'.repeat(64)}`,
      storageReference: '123e4567-e89b-12d3-a456-426614174000.mdse',
      packageSha256: `sha256:${'c'.repeat(64)}`,
      createdByUserId: 'admin-a',
      expiresAt: '2026-08-06T21:00:00.000Z',
      downloadedAt: null,
      createdAt: '2026-08-05T21:00:00.000Z',
    },
    token: 'A'.repeat(43),
  };
}

function dependencies() {
  return {
    verifyPassword: vi.fn().mockResolvedValue(true),
    validateApproval: vi.fn().mockResolvedValue({ validForDeliveryPackaging: true }),
    createPackage: vi.fn().mockResolvedValue(createdPackage()),
  };
}

describe('data subject package admin HTTP boundary', () => {
  it('requires a tenant admin before parsing or reauthenticating', async () => {
    const deps = dependencies();
    const response = await serveDataSubjectDeliveryPackageCreation(request({}), {
      ...context,
      role: 'TRAINER',
    }, deps);

    expect(response.status).toBe(403);
    expect(deps.verifyPassword).not.toHaveBeenCalled();
    expect(deps.validateApproval).not.toHaveBeenCalled();
    expect(deps.createPackage).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('rejects malformed requests and failed reauthentication before approval validation', async () => {
    const malformedDeps = dependencies();
    const malformed = await serveDataSubjectDeliveryPackageCreation(request({
      athleteId: 'athlete-a', approvalId: 'approval-a',
    }), context, malformedDeps);
    expect(malformed.status).toBe(400);
    expect(malformedDeps.verifyPassword).not.toHaveBeenCalled();

    const failedDeps = dependencies();
    failedDeps.verifyPassword.mockResolvedValue(false);
    const failed = await serveDataSubjectDeliveryPackageCreation(request({
      password: 'wrong', athleteId: 'athlete-a', approvalId: 'approval-a',
    }), context, failedDeps);
    expect(failed.status).toBe(401);
    expect(failedDeps.validateApproval).not.toHaveBeenCalled();
    expect(failedDeps.createPackage).not.toHaveBeenCalled();
  });

  it('blocks a stale approval without creating or returning a token', async () => {
    const deps = dependencies();
    deps.validateApproval.mockResolvedValue({ validForDeliveryPackaging: false });

    const response = await serveDataSubjectDeliveryPackageCreation(request({
      password: 'correct', athleteId: 'athlete-a', approvalId: 'approval-a',
    }), context, deps);

    expect(response.status).toBe(409);
    expect(deps.createPackage).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'DATA_SUBJECT_EXPORT_APPROVAL_NOT_CURRENT' });
  });

  it('returns the one-time bearer token only in a no-store response and never embeds it in the endpoint URL', async () => {
    const deps = dependencies();
    const response = await serveDataSubjectDeliveryPackageCreation(request({
      password: 'correct', athleteId: 'athlete-a', approvalId: 'approval-a',
    }), context, deps);

    expect(response.status).toBe(201);
    expect(deps.createPackage).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      approvalId: 'approval-a',
      actor: context,
    });
    const body = await response.json() as Record<string, unknown>;
    expect(body.downloadToken).toBe('A'.repeat(43));
    expect(body.tokenType).toBe('Bearer');
    expect(body.downloadEndpoint).toBe('https://diagnostics.example.test/api/data-subject/export/download');
    expect(String(body.downloadEndpoint)).not.toContain(String(body.downloadToken));
    expect(body).not.toHaveProperty('password');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('maps a source drift during package creation to 409 but keeps genuine writer failures at 500', async () => {
    const driftDeps = dependencies();
    driftDeps.createPackage.mockRejectedValue(new Error('source changed'));
    driftDeps.validateApproval
      .mockResolvedValueOnce({ validForDeliveryPackaging: true })
      .mockResolvedValueOnce({ validForDeliveryPackaging: false });

    const drift = await serveDataSubjectDeliveryPackageCreation(request({
      password: 'correct', athleteId: 'athlete-a', approvalId: 'approval-a',
    }), context, driftDeps);
    expect(drift.status).toBe(409);

    const failureDeps = dependencies();
    failureDeps.createPackage.mockRejectedValue(new Error('storage failed'));
    const failure = await serveDataSubjectDeliveryPackageCreation(request({
      password: 'correct', athleteId: 'athlete-a', approvalId: 'approval-a',
    }), context, failureDeps);
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: 'DATA_SUBJECT_EXPORT_PACKAGE_CREATION_FAILED' });
  });
});
