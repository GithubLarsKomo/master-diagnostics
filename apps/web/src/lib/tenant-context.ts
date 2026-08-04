import type { Role } from '@masters/domain';
import { headers } from 'next/headers';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
  authProvider: 'BETTER_AUTH' | 'CLERK';
  sessionId: string;
}

export async function getTenantContext(): Promise<TenantContext> {
  const requestHeaders = await headers();
  const tenantId = requestHeaders.get('x-masters-tenant-id');
  const userId = requestHeaders.get('x-masters-user-id');
  const role = requestHeaders.get('x-masters-role') as Role | null;
  const authProvider = requestHeaders.get('x-masters-auth-provider') as TenantContext['authProvider'] | null;
  const sessionId = requestHeaders.get('x-masters-session-id');

  if (!tenantId || !userId || !role || !authProvider || !sessionId) {
    throw new Error('Authenticated tenant context is unavailable');
  }

  if (authProvider !== 'BETTER_AUTH' && authProvider !== 'CLERK') {
    throw new Error('Authenticated tenant context contains an unsupported auth provider');
  }

  return { tenantId, userId, role, authProvider, sessionId };
}
