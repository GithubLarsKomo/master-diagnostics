'use client';

import type { TestReviewRow } from '@masters/db';
import { type FormEvent, useState } from 'react';

const qualityLabels = {
  VALID: 'Gültig',
  PARTIAL: 'Teilstufe',
  EXCLUDED: 'Ausgeschlossen',
  MISSING: 'Fehlend',
  MANUALLY_CORRECTED: 'Manuell korrigiert',
} as const;

function rowLabel(row: TestReviewRow): string {
  if (row.kind === 'REST') return 'Ruhewert';
  if (row.kind === 'RECOVERY') return '5-Minuten-Erholung';
  return `Stufe ${row.stageNumber}`;
}

function toLocalDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function lactateText(value: number | null): string {
  return value === null
    ? ''
    : (value / 100).toFixed(2).replace('.', ',');
}

function parseLactate(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 30) {
    throw new Error('Laktat muss zwischen 0,5 und 30,0 mmol/L liegen.');
  }
  return Math.round(parsed * 100);
}

function parseHeartRate(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 20 || parsed > 250) {
    throw new Error('Herzfrequenz muss zwischen 20 und 250 liegen.');
  }
  return parsed;
}

function summary(row: TestReviewRow): string {
  const lactate = row.lactateValueX100 === null
    ? 'Laktat —'
    : `Laktat ${(row.lactateValueX100 / 100).toFixed(2).replace('.', ',')}`;
  const heartRate = row.heartRate === null ? 'HF —' : `HF ${row.heartRate}`;
  const quality = row.qualityStatus ? ` · ${qualityLabels[row.qualityStatus]}` : '';
  return `${lactate} · ${heartRate}${quality} · Version ${row.version}`;
}

function ReviewRowEditor({
  testId,
  initialRow,
}: {
  testId: string;
  initialRow: TestReviewRow;
}) {
  const label = rowLabel(initialRow);
  const [row, setRow] = useState(initialRow);
  const [lactate, setLactate] = useState(lactateText(initialRow.lactateValueX100));
  const [qualifier, setQualifier] = useState(
    initialRow.lactateQualifier ?? 'EXACT',
  );
  const [heartRate, setHeartRate] = useState(
    initialRow.heartRate?.toString() ?? '',
  );
  const [measuredAt, setMeasuredAt] = useState(
    toLocalDateTime(initialRow.measuredAt),
  );
  const [qualityStatus, setQualityStatus] = useState(
    initialRow.qualityStatus ?? 'MISSING',
  );
  const [notes, setNotes] = useState(initialRow.notes ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TestReviewRow | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setConflict(null);
    try {
      const lactateValueX100 = parseLactate(lactate);
      const parsedHeartRate = parseHeartRate(heartRate);
      const response = await fetch(
        `/api/tests/${encodeURIComponent(testId)}/review/measurements`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: row.kind,
            stageNumber: row.stageNumber,
            expectedVersion: row.version,
            heartRate: parsedHeartRate,
            lactateValueX100,
            lactateQualifier: lactateValueX100 === null ? null : qualifier,
            measuredAt: measuredAt
              ? new Date(measuredAt).toISOString()
              : null,
            qualityStatus: row.kind === 'STAGE' ? qualityStatus : null,
            notes: row.kind === 'STAGE' ? notes : null,
            reason,
          }),
        },
      );
      const result = await response.json() as
        | { status: 'APPLIED'; row: TestReviewRow }
        | { status: 'CONFLICT'; row: TestReviewRow }
        | { error: string };
      if ('error' in result) throw new Error(result.error);
      if (result.status === 'CONFLICT') {
        setConflict(result.row);
        setMessage('Konflikt: Der Serverstand wurde zwischenzeitlich geändert.');
        return;
      }
      setRow(result.row);
      setLactate(lactateText(result.row.lactateValueX100));
      setQualifier(result.row.lactateQualifier ?? 'EXACT');
      setHeartRate(result.row.heartRate?.toString() ?? '');
      setMeasuredAt(toLocalDateTime(result.row.measuredAt));
      setQualityStatus(result.row.qualityStatus ?? 'MISSING');
      setNotes(result.row.notes ?? '');
      setReason('');
      setMessage(`Gespeichert · Version ${result.row.version}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Korrektur fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="review-row" role="row" onSubmit={save}>
      <div role="cell">
        <strong>{label}</strong>
        <small>{row.targetWatts === null ? '—' : `${row.targetWatts} W`}</small>
      </div>
      <label role="cell">Laktat
        <input
          aria-label={`Laktat ${label}`}
          value={lactate}
          onChange={(event) => setLactate(event.target.value)}
          inputMode="decimal"
        />
      </label>
      <label role="cell">Qualifier
        <select
          aria-label={`Qualifier ${label}`}
          value={qualifier}
          onChange={(event) => setQualifier(event.target.value as typeof qualifier)}
          disabled={!lactate.trim()}
        >
          <option value="EXACT">Exakt</option>
          <option value="LESS_THAN">Kleiner als</option>
          <option value="GREATER_THAN">Größer als</option>
        </select>
      </label>
      <label role="cell">Herzfrequenz
        <input
          aria-label={`Herzfrequenz ${label}`}
          value={heartRate}
          onChange={(event) => setHeartRate(event.target.value)}
          inputMode="numeric"
        />
      </label>
      <label role="cell">Messzeitpunkt
        <input
          aria-label={`Messzeitpunkt ${label}`}
          type="datetime-local"
          value={measuredAt}
          onChange={(event) => setMeasuredAt(event.target.value)}
        />
      </label>
      <label role="cell">Qualität
        {row.kind === 'STAGE' ? (
          <select
            aria-label={`Qualität ${label}`}
            value={qualityStatus}
            onChange={(event) => setQualityStatus(
              event.target.value as typeof qualityStatus,
            )}
          >
            {Object.entries(qualityLabels).map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
        ) : <span>—</span>}
      </label>
      <label role="cell">Bemerkung
        <input
          aria-label={`Bemerkung ${label}`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          disabled={row.kind !== 'STAGE'}
          maxLength={2_000}
        />
      </label>
      <label role="cell">Korrekturgrund
        <input
          aria-label={`Korrekturgrund ${label}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={5}
          maxLength={500}
          required
        />
      </label>
      <div role="cell">
        <button type="submit" disabled={saving}>
          {saving ? 'Speichert' : `${label} speichern`}
        </button>
        {message && (
          <small className={conflict ? 'timer-alert' : ''} role="status">
            {message}
          </small>
        )}
        {conflict && (
          <small role="alert">
            Dein Entwurf bleibt erhalten. Server: {summary(conflict)}
          </small>
        )}
      </div>
    </form>
  );
}

export function TestReviewTable({
  testId,
  rows,
}: {
  testId: string;
  rows: TestReviewRow[];
}) {
  return (
    <section className="card" aria-labelledby="review-heading">
      <p className="eyebrow">Versionierte Nachbearbeitung</p>
      <h2 id="review-heading">Messwerte prüfen und korrigieren</h2>
      <p>
        Jede Speicherung benötigt eine Begründung. Parallele Änderungen werden
        als Konflikt angezeigt und niemals überschrieben.
      </p>
      <div className="review-table" role="table" aria-label="Messwerttabelle">
        <div className="review-header" role="row">
          <strong role="columnheader">Messpunkt</strong>
          <strong role="columnheader">Laktat</strong>
          <strong role="columnheader">Qualifier</strong>
          <strong role="columnheader">HF</strong>
          <strong role="columnheader">Zeitpunkt</strong>
          <strong role="columnheader">Qualität</strong>
          <strong role="columnheader">Bemerkung</strong>
          <strong role="columnheader">Grund</strong>
          <strong role="columnheader">Aktion</strong>
        </div>
        {rows.map((row) => (
          <ReviewRowEditor
            key={`${row.kind}:${row.stageNumber ?? ''}`}
            testId={testId}
            initialRow={row}
          />
        ))}
      </div>
    </section>
  );
}
