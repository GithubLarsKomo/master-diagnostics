import { describe, expect, it, vi } from 'vitest';
import { serveDataSubjectDeliveryDownload } from './data-subject-delivery-http';

const token = 'A'.repeat(43);

function request(authorization?: string): Request {
  return new Request('https://diagnostics.example.test/api/data-subject/export/download?token=ignored', {
    headers: authorization ? { Authorization: authorization } : undefined,
  });
}

describe('data subject delivery HTTP boundary', () => {
  it('accepts only a well-formed bearer token from Authorization and does not invoke consume otherwise', async () => {
    const consume = vi.fn();

    for (const authorization of [
      undefined,
      token,
      `bearer ${token}`,
      'Bearer short',
      `Bearer ${'!'.repeat(43)}`,
    ]) {
      const response = await serveDataSubjectDeliveryDownload(request(authorization), { consume });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }

    expect(consume).not.toHaveBeenCalled();
  });

  it('returns a one-time TAR with restrictive response headers for a successful consume', async () => {
    const bytes = new TextEncoder().encode('tar-bytes');
    const consume = vi.fn().mockResolvedValue({
      packageId: '123e4567-e89b-12d3-a456-426614174000',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      fileName: 'masters-data-subject-export-123e4567-e89b-12d3-a456-426614174000.tar',
      mediaType: 'application/x-tar' as const,
      bytes,
    });

    const response = await serveDataSubjectDeliveryDownload(request(`Bearer ${token}`), { consume });

    expect(response.status).toBe(200);
    expect(consume).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith(token);
    expect(response.headers.get('content-type')).toBe('application/x-tar');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="masters-data-subject-export-123e4567-e89b-12d3-a456-426614174000.tar"',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('collapses unknown, expired or consumed tokens to the same non-disclosing 404', async () => {
    const consume = vi.fn().mockResolvedValue(null);

    const response = await serveDataSubjectDeliveryDownload(request(`Bearer ${token}`), { consume });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('fails closed if the download service throws or returns an unsafe filename', async () => {
    const failed = await serveDataSubjectDeliveryDownload(request(`Bearer ${token}`), {
      consume: vi.fn().mockRejectedValue(new Error('storage failure')),
    });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('');
    expect(failed.headers.get('cache-control')).toContain('no-store');

    const unsafe = await serveDataSubjectDeliveryDownload(request(`Bearer ${token}`), {
      consume: vi.fn().mockResolvedValue({
        packageId: '123e4567-e89b-12d3-a456-426614174000',
        tenantId: 'tenant-a',
        athleteId: 'athlete-a',
        fileName: '../../subject.tar',
        mediaType: 'application/x-tar' as const,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    });
    expect(unsafe.status).toBe(500);
    expect(await unsafe.text()).toBe('');
  });
});
