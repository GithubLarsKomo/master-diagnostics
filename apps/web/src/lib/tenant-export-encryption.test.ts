import { describe, expect, it } from 'vitest';
import {
  decryptTenantExport,
  encryptTenantExport,
} from './tenant-export-encryption';

describe('tenant export encryption', () => {
  it('round-trips plaintext with a fresh non-persisted key', () => {
    const plaintext = Buffer.from('{"schemaVersion":"masters-tenant-export-v1"}\n', 'utf8');
    const first = encryptTenantExport(plaintext);
    const second = encryptTenantExport(plaintext);

    expect(first.decryptionKey).not.toBe(second.decryptionKey);
    expect(first.package.iv).not.toBe(second.package.iv);
    expect(Buffer.from(decryptTenantExport(first.package, first.decryptionKey))).toEqual(plaintext);
  });

  it('rejects tampered authenticated ciphertext', () => {
    const encrypted = encryptTenantExport(Buffer.from('sensitive tenant export', 'utf8'));
    const tampered = {
      ...encrypted.package,
      ciphertext: `${encrypted.package.ciphertext.slice(0, -4)}AAAA`,
    };

    expect(() => decryptTenantExport(tampered, encrypted.decryptionKey)).toThrow();
  });
});
