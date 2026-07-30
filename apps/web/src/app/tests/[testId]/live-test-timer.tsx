'use client';

import {
  getTestTimerPosition,
  type TestTimerPlan,
} from '@masters/domain';
import {
  createLiveTestTimerState,
  pauseLiveTestTimerState,
  resumeLiveTestTimerState,
  type LiveTestTimerState,
} from '@masters/sync';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadLiveTestTimerState,
  saveLiveTestTimerState,
} from '@/lib/live-test-timer-storage';

const phaseLabels = {
  WARMUP: 'Warm-up',
  READINESS: 'Bereitschaft',
  STAGE: 'Belastungsstufe',
  MEASUREMENT_PAUSE: 'Messpause',
  RECOVERY: '5-Minuten-Erholung',
} as const;

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

export function LiveTestTimer({
  plan,
  testId,
  startedAt,
  onActiveElapsedSecondsChange,
}: {
  plan: TestTimerPlan;
  testId: string;
  startedAt: string;
  onActiveElapsedSecondsChange: (seconds: number) => void;
}) {
  const [now, setNow] = useState(0);
  const [timerState, setTimerState] = useState<LiveTestTimerState | null>(null);
  const [persistenceStatus, setPersistenceStatus] = useState<
    'LOADING' | 'SAVING' | 'SAVED' | 'ERROR'
  >('LOADING');
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const writeRevision = useRef(0);

  useEffect(() => {
    let disposed = false;
    async function hydrate() {
      const timestamp = Date.now();
      try {
        const restored = await loadLiveTestTimerState(testId, startedAt);
        const state = restored ?? createLiveTestTimerState(testId, startedAt, timestamp);
        if (!restored) await saveLiveTestTimerState(state);
        if (disposed) return;
        setTimerState(state);
        setPersistenceStatus('SAVED');
      } catch {
        if (disposed) return;
        setTimerState(createLiveTestTimerState(testId, startedAt, timestamp));
        setPersistenceStatus('ERROR');
      }
      if (!disposed) setNow(timestamp);
    }
    void hydrate();
    return () => {
      disposed = true;
    };
  }, [startedAt, testId]);

  useEffect(() => {
    if (!timerState || timerState.pausedAtMs !== null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [timerState]);

  const activeElapsedSeconds = useMemo(() => {
    if (now === 0 || !timerState) return 0;
    const effectiveNow = timerState.pausedAtMs ?? now;
    return Math.max(
      0,
      (
        effectiveNow
        - Date.parse(startedAt)
        - timerState.accumulatedPauseMs
      ) / 1000,
    );
  }, [now, startedAt, timerState]);
  useEffect(() => {
    onActiveElapsedSecondsChange(activeElapsedSeconds);
  }, [activeElapsedSeconds, onActiveElapsedSecondsChange]);
  const position = getTestTimerPosition(plan, activeElapsedSeconds);
  const warning = (
    position.phase?.kind === 'STAGE'
    && position.phaseRemainingSeconds <= 30
  );
  const isPaused = timerState?.pausedAtMs != null;

  function persist(state: LiveTestTimerState) {
    const revision = ++writeRevision.current;
    setPersistenceStatus('SAVING');
    writeQueue.current = writeQueue.current
      .catch(() => undefined)
      .then(() => saveLiveTestTimerState(state));
    void writeQueue.current.then(
      () => {
        if (revision === writeRevision.current) setPersistenceStatus('SAVED');
      },
      () => {
        if (revision === writeRevision.current) setPersistenceStatus('ERROR');
      },
    );
  }

  function pause() {
    if (!timerState) return;
    const timestamp = Date.now();
    const state = pauseLiveTestTimerState(timerState, timestamp);
    setNow(timestamp);
    setTimerState(state);
    persist(state);
  }

  function resume() {
    if (!timerState || timerState.pausedAtMs === null) return;
    const timestamp = Date.now();
    const state = resumeLiveTestTimerState(timerState, timestamp);
    setTimerState(state);
    setNow(timestamp);
    persist(state);
  }

  if (position.completed) {
    return (
      <section className="live-test card" aria-live="polite">
        <p className="eyebrow">Timer abgeschlossen</p>
        <h2>Nachbelastungsmessung fällig</h2>
        <p>Der geführte Ablauf ist beendet. Schließe den Test über die Abschlussaktion ab.</p>
      </section>
    );
  }

  const phase = position.phase!;
  return (
    <section className={`live-test card${warning ? ' timer-warning' : ''}`} aria-live="polite">
      <div className="live-test-heading">
        <div>
          <p className="eyebrow">
            {isPaused ? 'Test pausiert' : 'Test läuft'}
          </p>
          <h2>{phaseLabels[phase.kind]}{phase.stageNumber ? ` ${phase.stageNumber}` : ''}</h2>
        </div>
        <button
          type="button"
          disabled={!timerState}
          onClick={isPaused ? resume : pause}
        >
          {isPaused ? 'Fortsetzen' : 'Pause'}
        </button>
      </div>

      <div className="timer-display" aria-label="Countdown">
        {formatDuration(position.phaseRemainingSeconds)}
      </div>

      <dl className="live-test-metrics">
        <div><dt>Soll-Leistung</dt><dd>{phase.targetWatts ? `${phase.targetWatts} W` : '—'}</dd></div>
        <div><dt>Nächste Soll-Leistung</dt><dd>{position.nextStageTargetWatts ? `${position.nextStageTargetWatts} W` : '—'}</dd></div>
        <div><dt>Gesamtzeit</dt><dd>{formatDuration(position.totalElapsedSeconds)}</dd></div>
        <div><dt>Verbleibend</dt><dd>{formatDuration(position.totalRemainingSeconds)}</dd></div>
      </dl>

      {phase.kind === 'MEASUREMENT_PAUSE' && (
        <p className="sample-window" role="status">
          Probenfenster: noch {formatDuration(position.sampleWindowRemainingSeconds ?? 0)}
        </p>
      )}
      {warning && (
        <p className="timer-alert" role="alert">
          Stufenende in {Math.ceil(position.phaseRemainingSeconds)} Sekunden
        </p>
      )}
      <p className="connection-state">
        Verbindung: Online · Lokaler Timer: {
          persistenceStatus === 'LOADING'
            ? 'Wird geladen'
            : persistenceStatus === 'SAVING'
              ? 'Wird gespeichert'
              : persistenceStatus === 'SAVED'
                ? 'Gespeichert'
                : 'Fehler'
        }
      </p>
      {persistenceStatus === 'ERROR' && (
        <p className="timer-alert" role="alert">
          Der lokale Timerzustand konnte nicht gespeichert werden.
        </p>
      )}
    </section>
  );
}
