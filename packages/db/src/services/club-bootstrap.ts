import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  authUsers,
  protocolTemplates,
  protocolTemplateVersions,
  tenantMemberships,
  tenants,
  userIdentities,
  users,
} from '../schema';
import { appendAuditEvent, auditActorFields } from './audit';
import { buildFactoryProtocolTemplateSeed } from './factory-protocol-templates';

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
  if (
    input.retentionYears < 1 ||
    input.retentionYears > 10
  ) {
    throw new Error(
      'Retention years must be between 1 and 10',
    );
  }

  const now = new Date().toISOString();
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const factoryProtocolTemplateSeed = buildFactoryProtocolTemplateSeed(
    tenantId,
    userId,
    now,
  );

  await db.transaction(async (tx) => {
    const existingTenants = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .limit(1);

    if (existingTenants.length > 0) {
      throw new Error(
        'Club installation is already configured',
      );
    }

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
    await tx
      .insert(protocolTemplates)
      .values(factoryProtocolTemplateSeed.map(({ template }) => template));
    await tx
      .insert(protocolTemplateVersions)
      .values(factoryProtocolTemplateSeed.map(({ version }) => version));
    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields({
        userId,
        role: 'TENANT_ADMIN',
        authProvider: 'BETTER_AUTH',
      }),
      action: 'club.bootstrap.completed',
      entityType: 'tenant',
      entityId: tenantId,
      source: 'SETUP_WIZARD',
      correlationId,
      after: {
        clubName: input.clubName,
        slug: input.slug,
        factoryProtocolTemplateCount: factoryProtocolTemplateSeed.length,
      },
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

export async function removeAuthUser(
  db: Database,
  authUserId: string,
): Promise<void> {
  await db
    .delete(authUsers)
    .where(eq(authUsers.id, authUserId));
}
