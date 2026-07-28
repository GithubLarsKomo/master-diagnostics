import type { Role } from '@masters/domain';
import { headers } from 'next/headers';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
}

export async function getTenantContext(): Promise<TenantContext> {
  const requestHeaders = await headers();
  const tenantId = requestHeaders.get('x-masters-tenant-id');
  const userId = requestHeaders.get('x-masters-user-id');
  const role = requestHeaders.get('x-masters-role') as Role | null;

  if (!tenantId || !userId || !role) {
    throw new Error('Authenticated tenant context is unavailable');
  }

  return { tenantId, userId, role };
}
