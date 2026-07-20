import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { auditEvents, tenantMemberships, tenants, userIdentities, users } from '../schema';

export interface ClubBootstrapInput {
  clubName: string;
  slug: string;
  timezone: string;
  locale: 'de' | 'en';
  retentionYears: number;
  admin: { authUserId: string; email: string; displayName: string };
}

export async function isClubConfigured(db: Database): Promise<boolean> {
  const rows = await db.select({ id: tenants.id }).from(tenants).limit(1);
  return rows.length > 0;
}

export async function bootstrapClub(db: Database, input: ClubBootstrapInput): Promise<{ tenantId: string; userId: string }> {
  if (await isClubConfigured(db)) throw new Error('Club installation is already configured');
  if (input.retentionYears < 1 || input.retentionYears > 10) throw new Error('Retention years must be between 1 and 10');

  const now = new Date().toISOString();
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(tenants).values({
      id: tenantId,
      slug: input.slug,
      name: input.clubName,
      deploymentMode: 'CLUB',
      timezone: input.timezone,
      locale: input.locale,
      retentionYears: input.retentionYears,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(users).values({
      id: userId,
      email: input.admin.email.toLowerCase(),
      displayName: input.admin.displayName,
      preferredLocale: input.locale,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(userIdentities).values({
      id: crypto.randomUUID(),
      userId,
      provider: 'BETTER_AUTH',
      providerSubject: input.admin.authUserId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(tenantMemberships).values({
      id: crypto.randomUUID(),
      tenantId,
      userId,
      role: 'TENANT_ADMIN',
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(), tenantId, occurredAt: now, actorUserId: userId, actorRole: 'TENANT_ADMIN',
      action: 'club.bootstrap.completed', entityType: 'tenant', entityId: tenantId, source: 'SETUP_WIZARD',
      correlationId, afterJson: JSON.stringify({ clubName: input.clubName, slug: input.slug }), createdAt: now, updatedAt: now,
    });
  });

  return { tenantId, userId };
}

export async function resolveMembership(db: Database, authUserId: string) {
  const rows = await db
    .select({ tenantId: tenantMemberships.tenantId, userId: users.id, role: tenantMemberships.role })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .innerJoin(tenantMemberships, and(eq(tenantMemberships.userId, users.id), eq(tenantMemberships.active, true)))
    .where(and(eq(userIdentities.provider, 'BETTER_AUTH'), eq(userIdentities.providerSubject, authUserId)))
    .limit(1);
  return rows[0] ?? null;
}
