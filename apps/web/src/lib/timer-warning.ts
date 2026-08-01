export const STAGE_WARNING_THRESHOLDS_SECONDS = [30, 10] as const;

export function getStageWarningThreshold(
  phaseRemainingSeconds: number,
): 30 | 10 | null {
  if (!Number.isFinite(phaseRemainingSeconds) || phaseRemainingSeconds < 0) return null;
  if (phaseRemainingSeconds <= 10) return 10;
  if (phaseRemainingSeconds <= 30) return 30;
  return null;
}

export function playTimerWarningTone(audioContext: AudioContext): void {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.2);
}
