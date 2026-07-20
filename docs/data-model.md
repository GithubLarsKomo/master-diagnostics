# Datenmodell

Das initiale Drizzle-Schema befindet sich unter `packages/db/src/schema`.

## Modellierungsregeln

- jede fachliche Entität enthält `tenant_id`
- keine Client-Eingabe bestimmt den Tenant-Kontext
- Freigaben werden versioniert, nicht überschrieben
- Audit-Ereignisse sind append-only
- JSON-Felder sind mit Zod-Schemata und einer Schema-Version zu koppeln
- Cross-Tenant-Beziehungen werden in Application Services und Isolationstests verhindert

## Noch zu ergänzende Tabellen

Das Grundschema deckt die Kernpfade ab. Vor Phase 6 werden unter anderem ergänzt:

- `guardian_consents`
- `athlete_context_updates`
- `test_condition_snapshots`
- `measurement_exclusions`
- `exports`, `imports`
- `update_runs`, `feature_flags`, `license_state`
