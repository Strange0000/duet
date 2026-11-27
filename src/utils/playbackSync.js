/**
 * Computes expected playback position in milliseconds from authoritative server state.
 */
export function computeExpectedPositionMs(playback, estimatedServerNowMs) {
  if (!playback) return 0;
  const durationMs = Math.max(0, playback.durationMs || 0);
  const anchorPos = Math.max(0, Math.min(durationMs, playback.anchorPositionMs || 0));

  if (playback.playbackState !== 'playing') {
    return anchorPos;
  }

  // If scheduled in the future, hold at anchorPositionMs until effectiveAtServerMs
  if (
    typeof playback.effectiveAtServerMs === 'number' &&
    estimatedServerNowMs < playback.effectiveAtServerMs
  ) {
    return anchorPos;
  }

  const elapsed = Math.max(0, estimatedServerNowMs - (playback.anchorServerTimeMs || estimatedServerNowMs));
  return Math.max(0, Math.min(durationMs, anchorPos + elapsed));
}

/**
 * Evaluates whether a drift correction seek should occur based on thresholds & cooldowns.
 * Thresholds:
 *  - < 150ms: no correction
 *  - 150ms..350ms: tolerate minor jitter
 *  - 350ms..1000ms: correct after >= 2 consecutive measurements + cooldown
 *  - > 1000ms: controlled seek (with cooldown)
 */
export function evaluateDriftCorrection({
  expectedMs,
  actualMs,
  lastCorrectionAtMs = 0,
  consecutiveModerateCount = 0,
  nowMs = Date.now(),
  // Real player duration in ms (from player.getDuration()). When the player
  // is within 1500ms of its real end, the track is ending naturally — never
  // seek it back, or onEnded never fires (N-02 / B2).
  playerDurationMs = null,
}) {
  const driftMs = actualMs - expectedMs;
  const absDrift = Math.abs(driftMs);

  if (
    typeof playerDurationMs === 'number' &&
    playerDurationMs > 0 &&
    actualMs >= playerDurationMs - 1500
  ) {
    return {
      action: 'none',
      driftMs: Math.round(driftMs),
      absDriftMs: Math.round(absDrift),
      nextConsecutiveCount: 0,
      nearEnd: true,
    };
  }

  if (absDrift < 150) {
    return {
      action: 'none',
      driftMs: Math.round(driftMs),
      absDriftMs: Math.round(absDrift),
      nextConsecutiveCount: 0,
    };
  }

  if (absDrift < 350) {
    return {
      action: 'tolerate',
      driftMs: Math.round(driftMs),
      absDriftMs: Math.round(absDrift),
      nextConsecutiveCount: 0,
    };
  }

  if (absDrift <= 1000) {
    const nextCount = consecutiveModerateCount + 1;
    const cooldownOk = nowMs - lastCorrectionAtMs >= 2500;
    if (nextCount >= 2 && cooldownOk) {
      return {
        action: 'seek',
        targetMs: Math.round(expectedMs),
        driftMs: Math.round(driftMs),
        absDriftMs: Math.round(absDrift),
        nextConsecutiveCount: 0,
      };
    }
    return {
      action: 'wait',
      driftMs: Math.round(driftMs),
      absDriftMs: Math.round(absDrift),
      nextConsecutiveCount: nextCount,
    };
  }

  // > 1000ms
  const cooldownOk = nowMs - lastCorrectionAtMs >= 1500;
  return {
    action: cooldownOk ? 'seek' : 'cooldown',
    targetMs: Math.round(expectedMs),
    driftMs: Math.round(driftMs),
    absDriftMs: Math.round(absDrift),
    nextConsecutiveCount: 0,
  };
}
