export type Role = 'PLATFORM_ADMIN' | 'TENANT_ADMIN' | 'TRAINER' | 'ATHLETE';

export const roleCapabilities = {
  PLATFORM_ADMIN: ['tenant.manage', 'platform.inspect'],
  TENANT_ADMIN: ['tenant.manage', 'athlete.manage', 'test.read.all', 'test.release'],
  TRAINER: ['athlete.read.assigned', 'test.plan', 'test.run', 'test.interpret'],
  ATHLETE: ['profile.read.self', 'profile.context.update.self', 'report.read.self'],
} as const satisfies Record<Role, readonly string[]>;
