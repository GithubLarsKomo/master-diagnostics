import { describe, expect, it } from 'vitest';
import { hasCapability, requireCapability } from '../src/authorization';

describe('authorization', () => {
  it('allows tenant admins to release tests', () => {
    expect(hasCapability('TENANT_ADMIN', 'test.release')).toBe(true);
  });

  it('denies athletes tenant management', () => {
    expect(() => requireCapability('ATHLETE', 'tenant.manage')).toThrow();
  });
});
