import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteGuardians,
  athleteSnapshots,
  athletes,
  auditEvents,
} from '../schema';

export type AuditPrivacyLocation = 'REASON' | 'BEFORE_JSON' | 'AFTER_JSON';

export type AuditDirectIdentifierClass =
  | 'ATHLETE_NAME'
  | 'ATHLETE_BIRTH_DATE'
  | 'ATHLETE_LINKED_USER'
  | 'GUARDIAN_NAME'
  | 'GUARDIAN_CONTACT';

export interface AuditPrivacyLocationMatch {
  location: AuditPrivacyLocation;
  identifierClasses: ReadonlyArray<AuditDirectIdentifierClass>;
}

export interface AuditPrivacyMaintenanceCandidate {
  auditEventId: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  matches: ReadonlyArray<Readonly<AuditPrivacyLocationMatch>>;
}

export interface AthleteAuditPrivacyInventory {
  mode: 'READ_ONLY';
  tenantId: string;
  athleteId: string;
  scannedEventCount: number;
  candidateCount: number;
  identifierClassCount: number;
  candidates: ReadonlyArray<Readonly<AuditPrivacyMaintenanceCandidate>>;
}

type Matcher = Readonly<{
  identifierClass: AuditDirectIdentifierClass;
  normalizedText?: string;
  normalizedDigits?: string;
}>;

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('de-DE').trim();
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function addTextMatcher(
  matchers: Matcher[],
  identifierClass: AuditDirectIdentifierClass,
  value: unknown,
): void {
  if (typeof value !== 'string') return;
  const normalizedText = normalizeText(value);
  if (normalizedText.length < 3) return;
  matchers.push(Object.freeze({ identifierClass, normalizedText }));
}

function addPhoneMatcher(
  matchers: Matcher[],
  value: unknown,
): void {
  if (typeof value !== 'string') return;
  addTextMatcher(matchers, 'GUARDIAN_CONTACT', value);
  const normalizedDigits = normalizeDigits(value);
  if (normalizedDigits.length >= 7) {
    matchers.push(Object.freeze({
      identifierClass: 'GUARDIAN_CONTACT',
      normalizedDigits,
    }));
  }
}

function addAthleteIdentityMatchers(
  matchers: Matcher[],
  source: Record<string, unknown>,
): void {
  const firstName = typeof source.firstName === 'string' ? source.firstName.trim() : '';
  const lastName = typeof source.lastName === 'string' ? source.lastName.trim() : '';

  addTextMatcher(matchers, 'ATHLETE_NAME', firstName);
  addTextMatcher(matchers, 'ATHLETE_NAME', lastName);
  if (firstName && lastName) {
    addTextMatcher(matchers, 'ATHLETE_NAME', `${firstName} ${lastName}`);
    addTextMatcher(matchers, 'ATHLETE_NAME', `${lastName}, ${firstName}`);
  }
  addTextMatcher(matchers, 'ATHLETE_BIRTH_DATE', source.birthDate);
  addTextMatcher(matchers, 'ATHLETE_LINKED_USER', source.linkedUserId);
}

function parseSnapshot(snapshotJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(snapshotJson);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function deduplicateMatchers(matchers: Matcher[]): ReadonlyArray<Matcher> {
  const unique = new Map<string, Matcher>();
  for (const matcher of matchers) {
    const key = `${matcher.identifierClass}|${matcher.normalizedText ?? ''}|${matcher.normalizedDigits ?? ''}`;
    unique.set(key, matcher);
  }
  return Object.freeze([...unique.values()]);
}

function classesMatching(value: string | null, matchers: ReadonlyArray<Matcher>) {
  if (!value) return [] as AuditDirectIdentifierClass[];
  const normalizedText = normalizeText(value);
  const normalizedDigits = normalizeDigits(value);
  const matches = new Set<AuditDirectIdentifierClass>();

  for (const matcher of matchers) {
    if (matcher.normalizedText && normalizedText.includes(matcher.normalizedText)) {
      matches.add(matcher.identifierClass);
    }
    if (
      matcher.normalizedDigits
      && normalizedDigits.includes(matcher.normalizedDigits)
    ) {
      matches.add(matcher.identifierClass);
    }
  }

  return [...matches].sort();
}

function locationMatch(
  location: AuditPrivacyLocation,
  value: string | null,
  matchers: ReadonlyArray<Matcher>,
): Readonly<AuditPrivacyLocationMatch> | null {
  const identifierClasses = classesMatching(value, matchers);
  return identifierClasses.length > 0
    ? Object.freeze({
      location,
      identifierClasses: Object.freeze(identifierClasses),
    })
    : null;
}

/**
 * Builds a conservative, tenant-scoped and completely read-only inventory of
 * historic audit entries that may still contain known direct identifiers for an
 * athlete. The result intentionally reports only event metadata and identifier
 * classes, never the matched personal values themselves.
 *
 * Historical athlete snapshots are included in the identifier vocabulary so
 * that former names/dates can still be detected after profile changes. This is
 * a high-recall candidate inventory for a later SPEC §33.3 maintenance policy;
 * it is not itself a redaction or deletion operation.
 */
export async function inventoryAthleteAuditPrivacyMaintenance(
  db: Database,
  tenantId: string,
  athleteId: string,
): Promise<Readonly<AthleteAuditPrivacyInventory>> {
  const [athlete] = await db
    .select()
    .from(athletes)
    .where(and(
      eq(athletes.id, athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .limit(1);
  if (!athlete) {
    throw new Error('Athlete not found');
  }

  const [snapshots, guardians, tenantAuditEvents] = await Promise.all([
    db
      .select({ snapshotJson: athleteSnapshots.snapshotJson })
      .from(athleteSnapshots)
      .where(and(
        eq(athleteSnapshots.tenantId, tenantId),
        eq(athleteSnapshots.athleteId, athleteId),
      )),
    db
      .select({
        fullName: athleteGuardians.fullName,
        email: athleteGuardians.email,
        phone: athleteGuardians.phone,
      })
      .from(athleteGuardians)
      .where(and(
        eq(athleteGuardians.tenantId, tenantId),
        eq(athleteGuardians.athleteId, athleteId),
      )),
    db
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.occurredAt,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        reason: auditEvents.reason,
        beforeJson: auditEvents.beforeJson,
        afterJson: auditEvents.afterJson,
      })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenantId))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)),
  ]);

  const matcherBuffer: Matcher[] = [];
  addAthleteIdentityMatchers(matcherBuffer, athlete as unknown as Record<string, unknown>);
  for (const snapshot of snapshots) {
    const parsed = parseSnapshot(snapshot.snapshotJson);
    if (parsed) addAthleteIdentityMatchers(matcherBuffer, parsed);
  }
  for (const guardian of guardians) {
    addTextMatcher(matcherBuffer, 'GUARDIAN_NAME', guardian.fullName);
    addTextMatcher(matcherBuffer, 'GUARDIAN_CONTACT', guardian.email);
    addPhoneMatcher(matcherBuffer, guardian.phone);
  }
  const matchers = deduplicateMatchers(matcherBuffer);

  const candidates = tenantAuditEvents.flatMap((event) => {
    const matches = [
      locationMatch('REASON', event.reason, matchers),
      locationMatch('BEFORE_JSON', event.beforeJson, matchers),
      locationMatch('AFTER_JSON', event.afterJson, matchers),
    ].filter((match): match is Readonly<AuditPrivacyLocationMatch> => match !== null);

    if (matches.length === 0) return [];
    return [Object.freeze({
      auditEventId: event.id,
      occurredAt: event.occurredAt,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      matches: Object.freeze(matches),
    })];
  });

  const identifierClasses = new Set(
    matchers.map((matcher) => matcher.identifierClass),
  );

  return Object.freeze({
    mode: 'READ_ONLY' as const,
    tenantId,
    athleteId,
    scannedEventCount: tenantAuditEvents.length,
    candidateCount: candidates.length,
    identifierClassCount: identifierClasses.size,
    candidates: Object.freeze(candidates),
  });
}
