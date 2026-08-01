'use client';

import {
  createLiveTestMeasurementsState,
  getLiveTestMeasurementCaptureProgress,
  liveTestMeasurementKey,
  upsertLiveTestMeasurement,
  type LactateQualifier,
  type LiveTestMeasurementsState,
  type LiveTestMeasurementTarget,
} from '@masters/sync';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  loadLiveTestMeasurementsState,
  saveLiveTestMeasurementsState,
} from '@/lib/live-test-measurements-storage';
import {
  enqueueLiveTestMeasurementSync,
  synchronizePendingLiveTestMeasurements,
  type LiveTestMeasurementSyncStatus,
} from '@/lib/live-test-measurement-sync';

type PersistenceStatus = 'LOADING' | 'SAVING' | 'SAVED' | 'ERROR';
type SyncStatus = 'LOADING' | 'SYNCING' | 'SYNCED' | 'PENDING' | 'CONFLICT';

const qualifierLabels: Record<LactateQualifier, string> = {
  EXACT: 'Exakt',
  LESS_THAN: 'Kleiner als',
  GREATER_THAN: 'Größer als',
};

function toLocalDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function targetFromKey(key: string): LiveTestMeasurementTarget {
  if (key === 'REST') return { kind: 'REST', stageNumber: null };
  if (key === 'RECOVERY') return { kind: 'RECOVERY', stageNumber: null };
  const stageNumber = Number(key.slice('STAGE:'.length));
  return { kind: 'STAGE', stageNumber };
}

function targetLabel(target: LiveTestMeasurementTarget): string {
  if (target.kind === 'REST') return 'Ruhewert';
  if (target.kind === 'RECOVERY') return '5-Minuten-Erholung';
  return `Stufe ${target.stageNumber}`;
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
    throw new Error('Herzfrequenz muss eine ganze Zahl zwischen 20 und 250 sein.');
  }
  return parsed;
}

export function LiveTestMeasurements({
  testId,
  startedAt,
  stageCount,
  lockToken,
}: {
  testId: string;
  startedAt: string;
  stageCount: number;
  lockToken: string;
}) {
  const [state, setState] = useState<LiveTestMeasurementsState | null>(null);
  const [selectedKey, setSelectedKey] = useState('REST');
  const [lactate, setLactate] = useState('');
  const [qualifier, setQualifier] = useState<LactateQualifier>('EXACT');
  const [heartRate, setHeartRate] = useState('');
  const [measuredAt, setMeasuredAt] = useState('');
  const [status, setStatus] = useState<PersistenceStatus>('LOADING');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('LOADING');
  const [conflict, setConflict] = useState<
    Extract<LiveTestMeasurementSyncStatus, { status: 'CONFLICT' }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const targets = useMemo<LiveTestMeasurementTarget[]>(
    () => [
      { kind: 'REST', stageNumber: null },
      ...Array.from(
        { length: stageCount },
        (_, index): LiveTestMeasurementTarget => ({
          kind: 'STAGE',
          stageNumber: index + 1,
        }),
      ),
      { kind: 'RECOVERY', stageNumber: null },
    ],
    [stageCount],
  );

  useEffect(() => {
    let disposed = false;
    async function hydrate() {
      const timestamp = Date.now();
      try {
        const restored = await loadLiveTestMeasurementsState(testId, startedAt, stageCount);
        const next = restored ?? createLiveTestMeasurementsState(
          testId,
          startedAt,
          stageCount,
          timestamp,
        );
        if (!restored) await saveLiveTestMeasurementsState(next);
        if (disposed) return;
        setState(next);
        setStatus('SAVED');
        const syncResult = await synchronizePendingLiveTestMeasurements(testId, lockToken);
        if (disposed) return;
        setSyncStatus(syncResult.status);
        setConflict(syncResult.status === 'CONFLICT' ? syncResult : null);
      } catch {
        if (disposed) return;
        setState(createLiveTestMeasurementsState(testId, startedAt, stageCount, timestamp));
        setStatus('ERROR');
        setSyncStatus('PENDING');
        setError('Der lokale Messwertspeicher ist nicht verfügbar.');
      }
    }
    void hydrate();
    return () => {
      disposed = true;
    };
  }, [lockToken, stageCount, startedAt, testId]);

  useEffect(() => {
    if (!state) return;
    const measurement = state.measurements[selectedKey];
    setLactate(
      measurement?.lactateValueX100 == null
        ? ''
        : (measurement.lactateValueX100 / 100).toFixed(1).replace('.', ','),
    );
    setQualifier(measurement?.lactateQualifier ?? 'EXACT');
    setHeartRate(measurement?.heartRate?.toString() ?? '');
    setMeasuredAt(toLocalDateTime(measurement?.measuredAt ?? new Date()));
    setError(null);
  }, [selectedKey, state]);

  async function saveMeasurement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    try {
      const lactateValueX100 = parseLactate(lactate);
      const parsedHeartRate = parseHeartRate(heartRate);
      if (lactateValueX100 === null && parsedHeartRate === null) {
        throw new Error('Mindestens Laktat oder Herzfrequenz muss erfasst werden.');
      }
      if (!measuredAt || !Number.isFinite(new Date(measuredAt).getTime())) {
        throw new Error('Der tatsächliche Messzeitpunkt ist erforderlich.');
      }
      const timestamp = Math.max(Date.now(), state.updatedAtMs);
      const next = upsertLiveTestMeasurement(state, {
        target: targetFromKey(selectedKey),
        lactateValueX100,
        lactateQualifier: lactateValueX100 === null ? null : qualifier,
        heartRate: parsedHeartRate,
        measuredAt: new Date(measuredAt).toISOString(),
        updatedAtMs: timestamp,
      });
      setState(next);
      setStatus('SAVING');
      setError(null);
      await saveLiveTestMeasurementsState(next);
      setStatus('SAVED');
      try {
        await enqueueLiveTestMeasurementSync(testId, next.measurements[selectedKey]!);
        setSyncStatus('SYNCING');
        const syncResult = await synchronizePendingLiveTestMeasurements(testId, lockToken);
        setSyncStatus(syncResult.status);
        setConflict(syncResult.status === 'CONFLICT' ? syncResult : null);
      } catch (syncError) {
        setSyncStatus('PENDING');
        setError(
          syncError instanceof Error
            ? `Lokal gespeichert; Server-Sync ausstehend: ${syncError.message}`
            : 'Lokal gespeichert; Server-Sync ausstehend.',
        );
      }
    } catch (caught) {
      setStatus('ERROR');
      setError(caught instanceof Error ? caught.message : 'Messwert konnte nicht gespeichert werden.');
    }
  }

  const savedMeasurements = state
    ? targets
      .map((target) => state.measurements[liveTestMeasurementKey(target)])
      .filter((measurement) => measurement !== undefined)
    : [];
  const captureProgress = state ? getLiveTestMeasurementCaptureProgress(state) : null;

  return (
    <section className="card live-measurements" aria-labelledby="measurement-heading">
      <p className="eyebrow">Lokaler Entwurf</p>
      <h2 id="measurement-heading">Messwerte erfassen</h2>
      <p>
        Ruhewert, Stufenwerte und die 5-Minuten-Erholung werden sofort lokal
        gespeichert und nach einem Browser-Neustart wiederhergestellt.
      </p>
      {captureProgress && (
        <div className={captureProgress.complete ? 'sample-window' : 'connection-state'} role="status">
          <strong>
            Erfassung {captureProgress.capturedCount}/{captureProgress.requiredCount}
            {captureProgress.complete ? ' vollständig' : ''}
          </strong>
          {!captureProgress.complete && (
            <span>
              {' · Fehlend: '}
              {captureProgress.missingTargets.map(targetLabel).join(', ')}
            </span>
          )}
        </div>
      )}

      <form className="measurement-form" onSubmit={saveMeasurement}>
        <label>Messpunkt
          <select
            value={selectedKey}
            onChange={(event) => setSelectedKey(event.target.value)}
            disabled={!state || status === 'SAVING' || syncStatus === 'SYNCING'}
          >
            {targets.map((target) => {
              const key = liveTestMeasurementKey(target);
              const captured = state?.measurements[key] !== undefined;
              return <option key={key} value={key}>{captured ? '✓ ' : ''}{targetLabel(target)}</option>;
            })}
          </select>
        </label>
        <label>Laktat (mmol/L)
          <input
            value={lactate}
            onChange={(event) => setLactate(event.target.value)}
            inputMode="decimal"
            placeholder="z. B. 1,20"
            disabled={!state || status === 'SAVING' || syncStatus === 'SYNCING'}
          />
        </label>
        <label>Qualifier
          <select
            value={qualifier}
            onChange={(event) => setQualifier(event.target.value as LactateQualifier)}
            disabled={!state || status === 'SAVING' || syncStatus === 'SYNCING' || !lactate.trim()}
          >
            {Object.entries(qualifierLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>Herzfrequenz (1/min)
          <input
            value={heartRate}
            onChange={(event) => setHeartRate(event.target.value)}
            inputMode="numeric"
            placeholder="z. B. 128"
            disabled={!state || status === 'SAVING' || syncStatus === 'SYNCING'}
          />
        </label>
        <label>Tatsächlicher Messzeitpunkt
          <input
            type="datetime-local"
            value={measuredAt}
            onChange={(event) => setMeasuredAt(event.target.value)}
            required
            disabled={!state || status === 'SAVING' || syncStatus === 'SYNCING'}
          />
        </label>
        <button
          type="submit"
          disabled={!state || status === 'SAVING' || syncStatus === 'SYNCING' || syncStatus === 'CONFLICT'}
        >
          Messwert lokal speichern
        </button>
      </form>

      <p className="connection-state" role="status">
        Lokale Messwerte: {status === 'LOADING' ? 'Werden geladen' : status === 'SAVING' ? 'Werden gespeichert' : status === 'SAVED' ? 'Gespeichert' : 'Fehler'}
      </p>
      <p className="connection-state" role="status">
        Server-Sync: {syncStatus === 'LOADING' ? 'Wird geprüft' : syncStatus === 'SYNCING' ? 'Wird synchronisiert' : syncStatus === 'SYNCED' ? 'Synchronisiert' : syncStatus === 'PENDING' ? 'Ausstehend' : 'Konflikt'}
      </p>
      {error && <p className="timer-alert" role="alert">{error}</p>}
      {syncStatus === 'PENDING' && status !== 'ERROR' && (
        <p className="sample-window">
          Die lokalen Werte bleiben erhalten und werden beim nächsten Öffnen erneut gesendet.
        </p>
      )}
      {conflict && (
        <div className="timer-alert" role="alert">
          <p>
            Der lokale Wert wurde nicht überschrieben. Auf dem Server liegt Version {conflict.serverVersion}.
          </p>
          <details>
            <summary>Serverstand anzeigen</summary>
            <pre>{JSON.stringify(conflict.serverState, null, 2)}</pre>
          </details>
        </div>
      )}

      {savedMeasurements.length > 0 && (
        <ul className="measurement-summary" aria-label="Gespeicherte Messwerte">
          {savedMeasurements.map((measurement) => (
            <li key={liveTestMeasurementKey(measurement.target)}>
              <strong>{targetLabel(measurement.target)}</strong>
              {' · '}Laktat {measurement.lactateValueX100 === null ? '—' : `${measurement.lactateQualifier === 'LESS_THAN' ? '< ' : measurement.lactateQualifier === 'GREATER_THAN' ? '> ' : ''}${(measurement.lactateValueX100 / 100).toFixed(1).replace('.', ',')} mmol/L`}
              {' · '}HF {measurement.heartRate ?? '—'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
