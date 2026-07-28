import type { Role } from './roles';

export type Capability =
  | 'tenant.manage'
  | 'athlete.manage'
  | 'athlete.read.assigned'
  | 'test.read.all'
  | 'test.plan'
  | 'test.run'
  | 'test.interpret'
  | 'test.release'
  | 'profile.read.self'
  | 'profile.context.update.self'
  | 'report.read.self'
  | 'platform.inspect';

export interface AuthorizationContext {
  tenantId: string;
  userId: string;
  role: Role;
}

const grants: Record<Role, ReadonlySet<Capability>> = {
  PLATFORM_ADMIN: new Set(['tenant.manage', 'platform.inspect']),
  TENANT_ADMIN: new Set(['tenant.manage', 'athlete.manage', 'test.read.all', 'test.release']),
  TRAINER: new Set(['athlete.read.assigned', 'test.plan', 'test.run', 'test.interpret']),
  ATHLETE: new Set(['profile.read.self', 'profile.context.update.self', 'report.read.self']),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return grants[role].has(capability);
}

export function requireCapability(role: Role, capability: Capability): void {
  if (!hasCapability(role, capability)) {
    throw new Error(`Role ${role} lacks capability ${capability}`);
  }
}

export function requireTenantAccess(
  context: AuthorizationContext,
  resourceTenantId: string,
): void {
  if (context.role !== 'PLATFORM_ADMIN' && context.tenantId !== resourceTenantId) {
    throw new Error('Cross-tenant access denied');
  }
}

export function authorize(
  context: AuthorizationContext,
  capability: Capability,
  resourceTenantId = context.tenantId,
): void {
  requireTenantAccess(context, resourceTenantId);
  requireCapability(context.role, capability);
}
