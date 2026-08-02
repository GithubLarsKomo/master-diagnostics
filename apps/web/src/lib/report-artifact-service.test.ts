import { describe, expect, it } from 'vitest';
import { readVerifiedReportArtifact } from './report-artifact-service';
import type { ReportArtifactStorage } from './report-artifact-storage';

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function storageFor(bytes: Uint8Array): ReportArtifactStorage {
  return {
    async put() {},
    async get() { return bytes; },
  };
}

describe('report artifact integrity', () => {
  it('returns persisted bytes only when their hash matches the immutable version', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nverified\n%%EOF');
    const contentHash = await sha256(bytes);
    const result = await readVerifiedReportArtifact(storageFor(bytes), {
      storageReference: 'tenant/test/de/report.pdf',
      contentHash,
    });
    expect(Array.from(result)).toEqual(Array.from(bytes));
  });

  it('rejects tampered persisted report bytes', async () => {
    const original = new TextEncoder().encode('%PDF-1.4\noriginal\n%%EOF');
    const tampered = new TextEncoder().encode('%PDF-1.4\ntampered\n%%EOF');
    await expect(readVerifiedReportArtifact(storageFor(tampered), {
      storageReference: 'tenant/test/de/report.pdf',
      contentHash: await sha256(original),
    })).rejects.toThrow('Report artifact integrity verification failed');
  });
});
