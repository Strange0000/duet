/**
 * Computes expected playback position in milliseconds from authoritative server state.
 */
export function computeExpectedPositionMs(playback, estimatedServerNowMs) {
  if (!playback) return 0;
  const durationMs = playback.durationMs > 0 ? playback.durationMs : Infinity;
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
  // Round 4: only report once the player has ACTUALLY STARTED the
  // expected video. On an errored player, getVideoUrl() still returns
  // the failed video's URL (so loadedId matches) while getDuration()
  // returns that video's YouTube length — which differs from the
  // track's stored length (Instant Crush 337s stored vs 340s on
  // YouTube, The Less I Know The Better 216s vs 343s) — and the server
  // overwrote the queue item's duration with the wrong value after
  // every failure. The caller passes playerHasStarted(playerState).
  playerStarted = true,
}) {
  if (!playerStarted) return false;
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
  // Round 4: my reported position minus the partner's reported position.
  // The old check only compared MY drift against the server anchor, so
  // when the host lagged the anchor the guest (following the anchor)
  // could sit ~25s ahead of the host while both pills said "In sync".
  // 'in-sync' now also requires the two tabs to be close to each other.
  // null when there is no partner position to compare against.
  partnerDriftMs = null,
}) {
  if (!hasRoomState) return 'waiting';

  let effective = playerState || null;
  if ((effective === 'buffering' || effective === 'paused') && positionAdvanced) {
    effective = 'playing';
  }

  // Round 4: the tabs are only "in sync" when BOTH are close to the
  // anchor AND close to each other.
  const partnerInSync = partnerDriftMs == null || Math.abs(partnerDriftMs) < 1500;

  if (effective === 'playing') {
    // E-14/I-07: when playing solo (no partner yet), show 'playing' instead
    // of 'waiting' — the music IS playing, just alone.
    if (!hasPartner) return 'playing';
    if (!partnerReady || !meReady) return 'waiting';
    return Math.abs(driftMs) < 350 && partnerInSync ? 'in-sync' : 'syncing';
  }
  if (effective === 'buffering') return 'buffering';
  if (effective === 'paused' || effective === 'ended') return 'paused';
  // F1: the local player failed to load/play (e.g. embedding-disabled).
  // Never fall through to server truth here — the server still says
  // "playing", which would show "In sync" while the video is dead.
  if (effective === 'error') return 'error';

  // No live local state yet (idle / ready / unknown): server truth.
  if (participantsBuffering) return 'buffering';
  if (serverPlaybackState === 'paused') return 'paused';
  if (serverPlaybackState === 'playing') {
    // E-14/I-07: solo host — show 'playing' not 'waiting'.
    if (!hasPartner) return 'playing';
    if (!partnerReady || !meReady) return 'waiting';
    return Math.abs(driftMs) < 350 && partnerInSync ? 'in-sync' : 'syncing';
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
  minSeekIntervalMs = 0,
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
    const cooldownOk = nowMs - lastCorrectionAtMs >= Math.max(2500, minSeekIntervalMs);
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
  const cooldownOk = nowMs - lastCorrectionAtMs >= Math.max(1500, minSeekIntervalMs);
  return {
    action: cooldownOk ? 'seek' : 'cooldown',
    targetMs: Math.round(expectedMs),
    driftMs: Math.round(driftMs),
    absDriftMs: Math.round(absDrift),
    nextConsecutiveCount: 0,
  };
}
