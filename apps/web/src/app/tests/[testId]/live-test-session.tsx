'use client';

import type { TestTimerPlan, TestTerminationReason } from '@masters/domain';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { LiveTestMeasurements } from './live-test-measurements';
import { LiveTestTimer } from './live-test-timer';

type LeaseState =
  | { status: 'ACQUIRING' }
  | { status: 'ACTIVE'; token: string; expiresAt: string }
  | { status: 'LOCKED'; ownerUserId: string; expiresAt: string }
  | { status: 'ERROR'; message: string };

const terminationLabels: Record<TestTerminationReason, string> = {
  REGULAR_EXHAUSTION: 'Reguläre Ausbelastung',
  VOLUNTARY_STOP: 'Freiwilliger Abbruch',
  TECHNICAL_FAILURE: 'Technische Störung',
  PAIN_OR_DISCOMFORT: 'Schmerzen oder Unwohlsein',
  ABNORMAL_HEART_RATE: 'Auffällige Herzfrequenz',
  PROTOCOL_ERROR: 'Protokollfehler',
  OTHER: 'Sonstiger Grund',
};

async function lockRequest(
  testId: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(`/api/tests/${encodeURIComponent(testId)}/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function LiveTestSession({
  plan,
  testId,
  startedAt,
  finishAction,
}: {
  plan: TestTimerPlan;
  testId: string;
  startedAt: string;
  finishAction: (formData: FormData) => Promise<void>;
}) {
  const [lease, setLease] = useState<LeaseState>({ status: 'ACQUIRING' });
  const [takeoverReason, setTakeoverReason] = useState('');
  const [takingOver, setTakingOver] = useState(false);
  const [activeElapsedSeconds, setActiveElapsedSeconds] = useState(0);
  const initialAcquireStarted = useRef(false);
  const storageKey = `masters:test-lock:${testId}`;

  const acquire = useCallback(async () => {
    setLease({ status: 'ACQUIRING' });
    try {
      const storedToken = window.sessionStorage.getItem(storageKey);
      if (storedToken) {
        const renewal = await lockRequest(testId, {
          action: 'renew',
          token: storedToken,
        });
        if (renewal.ok) {
          const renewed = await renewal.json() as { expiresAt: string };
          setLease({
            status: 'ACTIVE',
            token: storedToken,
            expiresAt: renewed.expiresAt,
          });
          return;
        }
        window.sessionStorage.removeItem(storageKey);
      }
      const response = await lockRequest(testId, { action: 'acquire' });
      const result = await response.json() as
        | {
          status: 'ACQUIRED';
          token: string;
          expiresAt: string;
        }
        | {
          status: 'LOCKED';
          ownerUserId: string;
          expiresAt: string;
        }
        | { error: string };
      if ('error' in result) throw new Error(result.error);
      if (result.status === 'LOCKED') {
        setLease(result);
        return;
      }
      setLease({
        status: 'ACTIVE',
        token: result.token,
        expiresAt: result.expiresAt,
      });
      window.sessionStorage.setItem(storageKey, result.token);
    } catch (error) {
      setLease({
        status: 'ERROR',
        message: error instanceof Error
          ? error.message
          : 'Bearbeitungssperre konnte nicht erworben werden.',
      });
    }
  }, [storageKey, testId]);

  useEffect(() => {
    if (initialAcquireStarted.current) return;
    initialAcquireStarted.current = true;
    void acquire();
  }, [acquire]);

  useEffect(() => {
    if (lease.status !== 'ACTIVE') return;
    const { token } = lease;
    const interval = window.setInterval(async () => {
      try {
        const response = await lockRequest(testId, { action: 'renew', token });
        if (!response.ok) throw new Error('Lease renewal failed');
        const result = await response.json() as { expiresAt: string };
        setLease((current) => (
          current.status === 'ACTIVE' && current.token === token
            ? { ...current, expiresAt: result.expiresAt }
            : current
        ));
      } catch {
        setLease({
          status: 'ERROR',
          message: 'Die Bearbeitungssperre konnte nicht verlängert werden. Eingaben sind vorsorglich gesperrt.',
        });
      }
    }, 20_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [lease, storageKey, testId]);

  async function takeOver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTakingOver(true);
    try {
      const response = await lockRequest(testId, {
        action: 'takeover',
        reason: takeoverReason,
      });
      const result = await response.json() as
        | { status: 'ACQUIRED'; token: string; expiresAt: string }
        | { error: string };
      if (!response.ok || 'error' in result) {
        throw new Error('error' in result ? result.error : 'Übernahme fehlgeschlagen');
      }
      setLease({
        status: 'ACTIVE',
        token: result.token,
        expiresAt: result.expiresAt,
      });
      window.sessionStorage.setItem(storageKey, result.token);
      setTakeoverReason('');
    } catch (error) {
      setLease({
        status: 'ERROR',
        message: error instanceof Error ? error.message : 'Übernahme fehlgeschlagen.',
      });
    } finally {
      setTakingOver(false);
    }
  }

  async function release() {
    if (lease.status !== 'ACTIVE') return;
    const token = lease.token;
    setLease({ status: 'ACQUIRING' });
    await lockRequest(testId, { action: 'release', token });
    window.sessionStorage.removeItem(storageKey);
    setLease({
      status: 'LOCKED',
      ownerUserId: '',
      expiresAt: new Date().toISOString(),
    });
  }

  if (lease.status !== 'ACTIVE') {
    return (
      <section className="card" aria-live="polite">
        <p className="eyebrow">Bearbeitungssperre</p>
        <h2>
          {lease.status === 'ACQUIRING'
            ? 'Bearbeitung wird reserviert'
            : 'Test ist nur lesbar'}
        </h2>
        {lease.status === 'ACQUIRING' && (
          <p>Die exklusive Gerätefreigabe wird geprüft.</p>
        )}
        {lease.status === 'LOCKED' && (
          <p>
            Ein anderes Gerät führt diesen Test aktiv. Die Sperre läuft spätestens
            {' '}{new Date(lease.expiresAt).toLocaleTimeString('de-DE')} ab.
          </p>
        )}
        {lease.status === 'ERROR' && (
          <p className="timer-alert" role="alert">{lease.message}</p>
        )}
        <button type="button" onClick={() => void acquire()}>
          Sperre erneut prüfen
        </button>
        <form className="setup-form" onSubmit={takeOver}>
          <label>Begründung für die Übernahme
            <textarea
              value={takeoverReason}
              onChange={(event) => setTakeoverReason(event.target.value)}
              minLength={5}
              maxLength={500}
              required
            />
          </label>
          <button type="submit" disabled={takingOver}>
            {takingOver ? 'Übernahme läuft' : 'Bearbeitung kontrolliert übernehmen'}
          </button>
        </form>
      </section>
    );
  }

  return (
    <>
      <section className="card" aria-live="polite">
        <p className="eyebrow">Bearbeitungssperre aktiv</p>
        <p>
          Dieses Gerät führt den Test exklusiv. Die Freigabe wird automatisch
          verlängert.
        </p>
        <button type="button" onClick={() => void release()}>
          Bearbeitung freigeben
        </button>
      </section>
      <LiveTestTimer
        plan={plan}
        testId={testId}
        startedAt={startedAt}
        onActiveElapsedSecondsChange={setActiveElapsedSeconds}
      />
      <LiveTestMeasurements
        testId={testId}
        startedAt={startedAt}
        stageCount={plan.stageCount}
        lockToken={lease.token}
      />
      <section className="card critical-action" aria-label="Testabschluss">
        <h2>Test sofort abbrechen</h2>
        <p>Diese Aktion bleibt während des gesamten laufenden Tests verfügbar.</p>
        <form action={finishAction} className="setup-form">
          <input type="hidden" name="lockToken" value={lease.token} />
          <input
            type="hidden"
            name="activeElapsedSeconds"
            value={activeElapsedSeconds}
          />
          <label>Abschluss- oder Abbruchgrund
            <select name="reason" required defaultValue="">
              <option value="" disabled>Grund auswählen</option>
              {Object.entries(terminationLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>Vermerk
            <textarea name="notes" rows={3} maxLength={2000} />
          </label>
          <button type="submit">Test sofort abbrechen</button>
        </form>
      </section>
    </>
  );
}
