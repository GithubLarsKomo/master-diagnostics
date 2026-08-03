import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const TENANT_EXPORT_ENCRYPTION_SCHEMA_VERSION = 'masters-tenant-export-encrypted-v1' as const;
export const TENANT_EXPORT_ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;

export interface EncryptedTenantExportPackage {
  schemaVersion: typeof TENANT_EXPORT_ENCRYPTION_SCHEMA_VERSION;
  algorithm: typeof TENANT_EXPORT_ENCRYPTION_ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface EncryptedTenantExportResult {
  package: EncryptedTenantExportPackage;
  decryptionKey: string;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new Error('Invalid tenant export decryption key');
  return key;
}

export function encryptTenantExport(plaintext: Uint8Array): EncryptedTenantExportResult {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    package: {
      schemaVersion: TENANT_EXPORT_ENCRYPTION_SCHEMA_VERSION,
      algorithm: TENANT_EXPORT_ENCRYPTION_ALGORITHM,
      iv: iv.toString('base64url'),
      authTag: authTag.toString('base64url'),
      ciphertext: ciphertext.toString('base64'),
    },
    decryptionKey: key.toString('base64url'),
  };
}

export function decryptTenantExport(
  encrypted: EncryptedTenantExportPackage,
  decryptionKey: string,
): Uint8Array {
  if (
    encrypted.schemaVersion !== TENANT_EXPORT_ENCRYPTION_SCHEMA_VERSION ||
    encrypted.algorithm !== TENANT_EXPORT_ENCRYPTION_ALGORITHM
  ) {
    throw new Error('Unsupported encrypted tenant export package');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    decodeKey(decryptionKey),
    Buffer.from(encrypted.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64url'));
  return new Uint8Array(Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]));
}
