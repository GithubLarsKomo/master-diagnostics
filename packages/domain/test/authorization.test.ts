import { describe, expect, it } from 'vitest';
import {
  authorize,
  hasCapability,
  requireCapability,
  requireTenantAccess,
  type Capability,
} from '../src/authorization';
import type { Role } from '../src/roles';

const expected: Record<Role, readonly Capability[]> = {
  PLATFORM_ADMIN: ['tenant.manage', 'platform.inspect'],
  TENANT_ADMIN: ['tenant.manage', 'athlete.manage', 'test.read.all', 'test.release'],
  TRAINER: ['athlete.read.assigned', 'test.plan', 'test.run', 'test.interpret'],
  ATHLETE: ['profile.read.self', 'profile.context.update.self', 'report.read.self'],
};

const allCapabilities = [...new Set(Object.values(expected).flat())];

describe('authorization', () => {
  for (const [role, capabilities] of Object.entries(expected) as [Role, readonly Capability[]][]) {
    it(`enforces the complete ${role} capability matrix`, () => {
      for (const capability of allCapabilities) {
        expect(hasCapability(role, capability)).toBe(capabilities.includes(capability));
      }
    });
  }

  it('denies capabilities that are not assigned', () => {
    expect(() => requireCapability('ATHLETE', 'tenant.manage')).toThrow(
      'Role ATHLETE lacks capability tenant.manage',
    );
  });

  it('denies cross-tenant access for tenant-scoped roles', () => {
    expect(() => requireTenantAccess({ tenantId: 'tenant-a', userId: 'user-1', role: 'TENANT_ADMIN' }, 'tenant-b'))
      .toThrow('Cross-tenant access denied');
  });

  it('allows access within the active tenant', () => {
    expect(() => authorize(
      { tenantId: 'tenant-a', userId: 'user-1', role: 'TRAINER' },
      'test.plan',
      'tenant-a',
    )).not.toThrow();
  });

  it('still requires a capability after tenant validation', () => {
    expect(() => authorize(
      { tenantId: 'tenant-a', userId: 'user-1', role: 'ATHLETE' },
      'test.plan',
      'tenant-a',
    )).toThrow('Role ATHLETE lacks capability test.plan');
  });
});
