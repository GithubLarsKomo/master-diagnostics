'use client';

import {
  getTestTimerPosition,
  type TestTimerPlan,
} from '@masters/domain';
import { useEffect, useMemo, useState } from 'react';

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
  startedAt,
}: {
  plan: TestTimerPlan;
  startedAt: string;
}) {
  const [now, setNow] = useState(0);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [accumulatedPauseMs, setAccumulatedPauseMs] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    if (pausedAt !== null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [pausedAt]);

  const activeElapsedSeconds = useMemo(() => {
    if (now === 0) return 0;
    const effectiveNow = pausedAt ?? now;
    return Math.max(
      0,
      (effectiveNow - Date.parse(startedAt) - accumulatedPauseMs) / 1000,
    );
  }, [accumulatedPauseMs, now, pausedAt]);
  const position = getTestTimerPosition(plan, activeElapsedSeconds);
  const warning = (
    position.phase?.kind === 'STAGE'
    && position.phaseRemainingSeconds <= 30
  );

  function pause() {
    const timestamp = Date.now();
    setNow(timestamp);
    setPausedAt(timestamp);
  }

  function resume() {
    if (pausedAt === null) return;
    const timestamp = Date.now();
    setAccumulatedPauseMs((value) => value + timestamp - pausedAt);
    setPausedAt(null);
    setNow(timestamp);
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
          <p className="eyebrow">{pausedAt === null ? 'Test läuft' : 'Test pausiert'}</p>
          <h2>{phaseLabels[phase.kind]}{phase.stageNumber ? ` ${phase.stageNumber}` : ''}</h2>
        </div>
        <button
          type="button"
          disabled={now === 0}
          onClick={pausedAt === null ? pause : resume}
        >
          {pausedAt === null ? 'Pause' : 'Fortsetzen'}
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
      <p className="connection-state">Verbindung: Online · Synchronisation: Serverstand</p>
    </section>
  );
}
