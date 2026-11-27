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
 * Whether the client may report a real player duration to the server
 * (player:duration, N-02).
 *
 * Right after Next, player.getDuration() still returns the PREVIOUS track's
 * length until the new video finishes loading. Reporting that value would
 * overwrite the NEW track's duration server-side (the server also copies it
 * onto the queue item's durationSec), which is exactly how Instant Crush
 * showed 04:04 — Midnight City's 243s — in Audio Only while the queue said
 * 05:39 (R5). So a report is only trustworthy when the player is confirmed
 * to be on the expected media; an unknown loaded id is also a "no".
 */
export function shouldReportRealDuration({
  loadedId,
  expectedId,
  realDurationMs,
  storedMs = 0,
  lastReportedMs = 0,
}) {
  if (!realDurationMs || realDurationMs <= 0) return false;
  if (!loadedId || !expectedId) return false;
  if (loadedId !== expectedId) return false;
  if (Math.abs(realDurationMs - storedMs) <= 2000) return false;
  if (Math.abs(realDurationMs - lastReportedMs) <= 2000) return false;
  return true;
}

/**
 * Now-playing duration in seconds for the UI.
 *
 * Prefer the server playback duration whenever it is known: the server sets
 * playback.durationMs atomically with the track on every track change, while
 * the UI's currentTrack still points at the PREVIOUS track until
 * queue:updated lands (playback:state is emitted first). Preferring the
 * track's durationSec therefore flashes the previous track's length for a
 * moment after every switch. When the server duration is unknown (0), fall
 * back to the track's stored duration.
 */
export function resolveNowPlayingDurationSec({ trackDurationSec, playbackDurationMs }) {
  const playbackSec = Math.round((playbackDurationMs || 0) / 1000);
  if (playbackSec > 0) return playbackSec;
  return trackDurationSec || 1;
}

/**
 * Effective playback status for the sync pill, derived from the LOCAL player
 * state first and the server state only as a fallback (R4).
 *
 * The old derivation read only server state (roomState.playback + the other
 * participants' `buffering` flags), which lag socket events: the pill showed
 * "Paused" while this tab's video was playing and "Buffering" while progress
 * advanced. The local player — via onStateChange and the 1s poll — is the
 * ground truth for what THIS tab is doing. `positionAdvanced` lets a
 * "buffering"/"paused" reading be overruled when the position is in fact
 * moving.
 */
export function resolvePlaybackStatus({
  playerState,
  positionAdvanced = false,
  serverPlaybackState,
  participantsBuffering = false,
  driftMs = 0,
  hasPartner = false,
  partnerReady = false,
  meReady = false,
  hasRoomState = true,
}) {
  if (!hasRoomState) return 'waiting';

  let effective = playerState || null;
  if ((effective === 'buffering' || effective === 'paused') && positionAdvanced) {
    effective = 'playing';
  }

  if (effective === 'playing') {
    if (!hasPartner || !partnerReady || !meReady) return 'waiting';
    return Math.abs(driftMs) < 350 ? 'in-sync' : 'syncing';
  }
  if (effective === 'buffering') return 'buffering';
  if (effective === 'paused' || effective === 'ended') return 'paused';

  // No live local state yet (idle / ready / unknown): server truth.
  if (participantsBuffering) return 'buffering';
  if (serverPlaybackState === 'paused') return 'paused';
  if (serverPlaybackState === 'playing') {
    if (!hasPartner || !partnerReady || !meReady) return 'waiting';
    return Math.abs(driftMs) < 350 ? 'in-sync' : 'syncing';
  }
  return 'waiting';
}

/**
 * Whether the local player has actually started the current track, for the
 * drift loop: a player still cueing/buffering must never be seek-corrected.
 */
export function playerHasStarted(playerState) {
  return playerState === 'playing' || playerState === 'paused';
}

/**
 * Stable identity of one playback command: the track, its version, the
 * play/pause state and the anchor it plays from. Two room:state broadcasts
 * that carry the same signature are the same command, not a new one.
 */
export function computePlaybackSignature(track, playback) {
  if (!track || !playback) return null;
  return [
    track.id,
    playback.trackVersion,
    playback.playbackState,
    playback.anchorPositionMs ?? 0,
    playback.anchorServerTimeMs ?? 0,
    playback.effectiveAtServerMs ?? '',
  ].join(':');
}

/**
 * Whether a playback state should be (re-)applied to the local player.
 *
 * The server re-broadcasts room:state ~every second (each player:status
 * report triggers one), and every broadcast re-runs the effect that drives
 * the player — so without this, play()/seek() were re-issued every second
 * while the room played. That restarted the YouTube load each time, so a
 * first Play sat on "Buffering" at 00:00 for ~40s, and it cleared the stall
 * watchdog before it could ever fire. A re-broadcast of the SAME command
 * therefore only re-applies when the player is actually in the wrong state
 * (paused while the room plays, or playing while the room is paused);
 * anything else — a new track, a new command, a changed anchor — always
 * re-applies.
 */
export function shouldReapplyPlayback({
  signature,
  lastSignature,
  trackKey,
  lastTrackKey,
  livePlayerState,
  playbackState,
}) {
  if (!signature || signature !== lastSignature || trackKey !== lastTrackKey) return true;
  if (playbackState === 'playing') {
    // Already playing, or already trying to start — leave it alone. A
    // paused/ready/idle player is the one case that needs a fresh play().
    return !['playing', 'buffering', 'cued', 'unstarted'].includes(livePlayerState);
  }
  // Room is paused: only re-apply when the player is still going.
  return !['paused', 'idle', 'ended'].includes(livePlayerState);
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
