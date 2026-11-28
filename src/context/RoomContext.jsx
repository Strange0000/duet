import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { INITIAL_TRACKS } from '../data/mockTracks';
import { LocalAudioPlayer } from '../players/LocalAudioPlayer';
import { SpotifyPlayer } from '../players/SpotifyPlayer';
import { YouTubePlayer } from '../players/YouTubePlayer';
import { emitAck, generateCommandId, getSocket } from '../services/socketClient';
import { backgroundAudio } from '../utils/backgroundAudio';
import { ClockSync } from '../utils/clockSync';
import { computeExpectedPositionMs, computePlaybackSignature, evaluateDriftCorrection, playerHasStarted, resolvePlaybackStatus, shouldReapplyPlayback, shouldReportRealDuration } from '../utils/playbackSync';

export const RoomContext = createContext(null);

const SESSION_STORAGE_KEY = 'duet_active_session';
const VOLUME_STORAGE_KEY = 'duet_volume';
const DEFAULT_VOLUME = 0.85;

// F2: server replies that mean "this socket is not adopted into the room
// (yet)" — transient during a refresh / reconnect, never a statement about
// the participant. Commands that hit one are retried once, and the user
// never sees the raw lookup text. Note the UNAUTHORIZED case: the server
// uses the same code for genuine permission failures ("Only the host can
// control playback"), so only the exact 'Participant not found' message
// counts as a membership error.
const isMembershipError = (res) =>
  res?.code === 'NOT_IN_ROOM' ||
  res?.code === 'PARTICIPANT_NOT_FOUND' ||
  (res?.code === 'UNAUTHORIZED' && res?.error === 'Participant not found');

// R3: how long the partner still counts as connected after their last
// observed traffic (player report, chat/reaction/typing, host command),
// even when the server's per-participant `connected` flag says otherwise.
const PARTNER_PRESENCE_GRACE_MS = 10000;

function loadStoredVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function saveSession(data) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage quota errors
  }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

// Identifier of the media a player must actually have loaded for a track,
// per source — used both for the drift-loop "still on the previous track"
// guard and for deciding whether a real duration is safe to report (R5).
function expectedMediaId(track, source) {
  if (!track) return null;
  if (source === 'spotify') return track.spotifyUri || null;
  if (source === 'audio' || source === 'local') return track.id || null;
  return track.youtubeId || null;
}

export function RoomProvider({ children }) {
  const [roomState, setRoomState] = useState(null);
  const [session, setSession] = useState(null); // { roomCode, participantId, sessionToken, role }
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  const [pendingApproval, setPendingApproval] = useState(null); // { roomCode, requestId }
  const [roomError, setRoomError] = useState(null);
  const [playerError, setPlayerError] = useState(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  // M3/M8: Duet volume control (UI subagent renders the slider).
  const [volume, setVolumeState] = useState(loadStoredVolume);
  const [muted, setMutedState] = useState(false);

  // Real sync telemetry
  const [syncMetrics, setSyncMetrics] = useState({
    rttMs: 0,
    clockOffsetMs: 0,
    driftMs: 0,
    reportedPositionMs: 0,
    expectedPositionMs: 0,
    correctionCount: 0,
    reconnectCount: 0,
    lastSyncedAtMs: null,
  });

  // Social state
  const [reactions, setReactions] = useState([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const partnerTypingTimerRef = useRef(null);

  // R3: last time we saw partner-attributable traffic. The server flips a
  // participant's `connected` flag to false the instant their socket drops
  // and only re-marks it on a successful room:reconnect, so a transient
  // blip leaves the other side showing "Disconnected" long after the
  // partner's Next/Pause/chat are flowing again. We therefore track real
  // liveness separately and derive presence from flag + recent traffic.
  const [partnerLastSeenAtMs, setPartnerLastSeenAtMs] = useState(null);
  // R3: ticking clock that re-evaluates derived presence every 2s, so a
  // genuinely gone partner flips to disconnected once the grace window
  // expires even when no further room event arrives.
  const [presenceTickMs, setPresenceTickMs] = useState(0);

  const markPartnerSeen = useCallback(() => {
    setPartnerLastSeenAtMs(Date.now());
  }, []);

  const clockSyncRef = useRef(new ClockSync());
  const playerRef = useRef(null);
  const playerInitVersionRef = useRef(0);
  const playerContainerRef = useRef(null);
  const lastCorrectionAtRef = useRef(0);
  const consecutiveDriftRef = useRef(0);
  const loadedTrackKeyRef = useRef(null);
  // Round 4: re-entrancy guard for applyPlaybackToPlayer. The B1 effect
  // fires on every room:state broadcast (~every second), and onError
  // resets the dedup signature — so during a recovery the effect can
  // re-enter applyPlaybackToPlayer while a previous invocation is still
  // awaiting recoverIfFailed()/initialize(). A concurrent invocation
  // could destroy a just-created player or double-issue the load. A
  // skipped invocation is safe: the next broadcast (~1s later) retries
  // it with the latest state.
  const applyInFlightRef = useRef(false);
  const roomStateRef = useRef(null);
  const sessionRef = useRef(null);
  // F2: whether THIS socket has been adopted into the room by the server
  // (room:join / room:reconnect / room:create ack, or a room:joined event).
  // After a refresh — or a mid-room socket drop + auto-reconnect — the
  // socket is connected but not yet adopted, and any command sent in that
  // window fails NOT_IN_ROOM / PARTICIPANT_NOT_FOUND. sendCommand waits for
  // this flag (bounded) before emitting, so a chat typed right after a
  // refresh is not lost to the adoption race.
  const adoptedRef = useRef(false);
  const audioUnlockedRef = useRef(false);
  const scheduledPlayTimerRef = useRef(null);
  // N-02: real player duration (ms) cached from player.getDuration(); the
  // stored duration can be wrong (e.g. 210s fallback for pasted URLs).
  const realDurationRef = useRef(0);
  const lastReportedDurationRef = useRef(0);
  // N-04: pending room:create promise, resolved by the room:created event.
  const pendingCreateRef = useRef(null);
  // R4: this tab's LOCAL player state — the ground truth for the status pill
  // and the Play/Pause button. Server playback state and the participants'
  // `buffering` flags lag socket events and go stale (guest showed "Paused"
  // while playing; host showed "Buffering" while progress advanced).
  const [playerState, setPlayerState] = useState('idle'); // 'idle' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended'
  const playerStateRef = useRef('idle');
  // R4: last player position seen by the 1s poll, so a "buffering"/"paused"
  // reading can be overruled when the position is in fact advancing.
  const lastPlayerPositionRef = useRef(0);
  // R1: first-play stall watchdog — one retry, then a real error instead of
  // spinning on "Loading…" forever.
  const playWatchdogTimerRef = useRef(null);
  const playWatchdogAttemptRef = useRef(0);
  // R1 (follow-up): signature of the last playback state actually applied
  // to the player. The server re-broadcasts room:state ~every second (each
  // player:status report triggers one) and the effect below re-runs on
  // every broadcast — without this, applyPlaybackToPlayer re-issued
  // play()/seek() every second, restarting the YouTube load each time so a
  // first Play never finished buffering, and it cleared the stall watchdog
  // before it could ever fire.
  const lastAppliedPlaybackRef = useRef(null);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);

  roomStateRef.current = roomState;
  sessionRef.current = session;
  audioUnlockedRef.current = audioUnlocked;
  volumeRef.current = volume;
  mutedRef.current = muted;

  const myParticipant = useMemo(() => {
    if (!roomState || !session) return null;
    return roomState.participants.find((p) => p.id === session.participantId) || null;
  }, [roomState, session]);

  const partnerParticipant = useMemo(() => {
    if (!roomState || !session) return null;
    return roomState.participants.find((p) => p.id !== session.participantId) || null;
  }, [roomState, session]);

  // R3: derived presence for the partner. The server flag wins when it says
  // connected; when it says disconnected we still show connected while the
  // partner's own traffic arrived within the grace window — their actions
  // arriving proves their socket is live, whatever the stale flag says.
  // presenceTickMs (a Date.now() snapshot refreshed every 2s) makes this
  // re-evaluate as the window expires, so a truly gone partner eventually
  // flips to disconnected without needing another room event.
  const partnerConnected = useMemo(() => {
    if (!partnerParticipant) return false;
    if (partnerParticipant.connected) return true;
    if (partnerLastSeenAtMs == null) return false;
    return presenceTickMs - partnerLastSeenAtMs <= PARTNER_PRESENCE_GRACE_MS;
  }, [partnerParticipant, partnerLastSeenAtMs, presenceTickMs]);

  const currentTrack = useMemo(() => {
    if (!roomState) return null;
    const found = roomState.queue.find((q) => q.queueItemId === roomState.currentQueueItemId);
    return found?.track || roomState.queue[0]?.track || null;
  }, [roomState]);

  // M5: human-readable sync status for the sync pill (UI subagent renders it).
  // R4: derived from the LOCAL player state first (resolvePlaybackStatus) —
  // the server's playback state and the participants' `buffering` flags lag
  // socket events and showed "Paused" while this tab was playing and
  // "Buffering" while progress advanced. Server state is only the fallback
  // while the local player has no live state yet (idle / ready).
  const syncStatus = useMemo(() => {
    const participants = roomState?.participants || [];
    const partner = participants.find((p) => session && p.id !== session.participantId) || null;
    const me = participants.find((p) => session && p.id === session.participantId);
    // Round 4 (c): the partner's reported position (broadcast with every
    // room:state, stored server-side by player:status) vs my reported
    // position. The old check only compared MY drift against the server
    // anchor — when the host lagged the anchor, the guest (following the
    // anchor) could sit ~25s ahead of the host while both pills said
    // "In sync". null when either side has no position yet.
    const partnerDriftMs =
      me && partner && typeof me.reportedPositionMs === 'number' && typeof partner.reportedPositionMs === 'number'
        ? Math.round((syncMetrics.reportedPositionMs || 0) - (partner.reportedPositionMs || 0))
        : null;
    return resolvePlaybackStatus({
      playerState,
      serverPlaybackState: roomState?.playback?.playbackState,
      participantsBuffering: participants.some((p) => p.buffering),
      driftMs: syncMetrics.driftMs,
      hasPartner: participants.length >= 2 && !!partner,
      partnerReady: !!partner?.ready,
      meReady: me ? !!me.ready : participants.length < 2,
      hasRoomState: !!roomState,
      partnerDriftMs,
    });
  }, [roomState, session, syncMetrics.driftMs, syncMetrics.reportedPositionMs, playerState]);

  // M3: volume / mute controls (UI subagent renders the slider).
  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, Number(v) || 0));
    setVolumeState(clamped);
    volumeRef.current = clamped;
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped));
    } catch {
      // Ignore storage errors
    }
    playerRef.current?.setVolume?.(clamped)?.catch?.(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    setMutedState(next);
    mutedRef.current = next;
    playerRef.current?.setMuted?.(next)?.catch?.(() => {});
  }, []);

  const clearRoomError = useCallback(() => {
    setRoomError(null);
  }, []);

  // N-25: fresh position straight from the player, not the 1s syncMetrics.
  const getCurrentPositionMs = useCallback(async () => {
    const player = playerRef.current;
    if (player && typeof player.getPosition === 'function') {
      try {
        return await player.getPosition();
      } catch {
        // Fall through to the last reported position
      }
    }
    return syncMetrics.reportedPositionMs;
  }, [syncMetrics.reportedPositionMs]);

  // N-02/B2: report the player's real duration to the server when it
  // differs from the stored duration by >2s. Only sends when the value
  // changed by >2s since the last report, so it never spams. R5: only ever
  // reports when the player is confirmed to be on the expected media —
  // shouldReportRealDuration refuses a duration read while the player is
  // still on the previous track (or its media is unknown).
  // Round 4 (a): also requires the player to have actually STARTED the
  // expected video. On an errored player getVideoUrl() still returns the
  // failed video's URL (loadedId matches) while getDuration() returns
  // that video's YouTube length, which differs from the stored one —
  // and the server overwrote the queue item's duration after failures
  // (Instant Crush 05:37 → 05:40, The Less I Know The Better 03:36 →
  // 05:43 in the round-3 re-test).
  const reportRealDuration = useCallback((realDurationMs, playback, { loadedId, expectedId, playerStarted = true } = {}) => {
    if (!realDurationMs || realDurationMs <= 0 || !playback) return;
    if (
      !shouldReportRealDuration({
        loadedId,
        expectedId,
        realDurationMs,
        storedMs: playback.durationMs || 0,
        lastReportedMs: lastReportedDurationRef.current || 0,
        playerStarted,
      })
    ) {
      return;
    }
    realDurationRef.current = realDurationMs;
    lastReportedDurationRef.current = realDurationMs;
    emitAck('player:duration', {
      durationMs: Math.round(realDurationMs),
      trackVersion: playback.trackVersion,
    }).catch(() => {});
  }, []);

  const runClockSync = useCallback(async () => {
    const metrics = await clockSyncRef.current.sync(
      (payload) => emitAck('sync:ping', payload, 3000),
      5
    );
    setSyncMetrics((prev) => ({
      ...prev,
      rttMs: metrics.rttMs,
      clockOffsetMs: metrics.clockOffsetMs,
      lastSyncedAtMs: metrics.lastSyncedAtMs,
    }));
  }, []);

  // R6: adopt the room's playback position the moment a room state is
  // received on join/rejoin — before any audio-unlock tap. The progress UI
  // reads syncMetrics.reportedPositionMs (the player's position, still 0
  // before unlock), so seed it from the authoritative playback anchor
  // here; a paused room rejoining at 00:55 shows 00:55 immediately.
  const seedPositionFromPlayback = useCallback((playback) => {
    if (!playback) return;
    const expectedMs = computeExpectedPositionMs(
      playback,
      clockSyncRef.current.estimateServerNowMs()
    );
    setSyncMetrics((prev) => ({
      ...prev,
      reportedPositionMs: Math.round(expectedMs),
      expectedPositionMs: Math.round(expectedMs),
      driftMs: 0,
    }));
  }, []);

  // R6: re-fetch the authoritative room snapshot after adopting a room.
  // Broadcasts (e.g. a theme change) that landed while this socket was
  // mid-reconnect can be missed; the snapshot heals that, so the adopted
  // theme/position is the room's current one, not a stale join-time copy.
  // A snapshot older than the state we already hold is ignored, and a
  // failure is best-effort — the adopted join state stays usable.
  const refreshRoomStateFromServer = useCallback(async () => {
    try {
      const res = await emitAck('sync:request', {}, 10000);
      const next = res?.state;
      if (!next) return;
      if ((next.roomVersion ?? 0) < (roomStateRef.current?.roomVersion ?? 0)) return;
      setRoomState(next);
      seedPositionFromPlayback(next.playback);
    } catch {
      // Best-effort only — the adopted join state is still usable.
    }
  }, [seedPositionFromPlayback]);

  // Apply authoritative playback state to local player
  // Round 4: the inner implementation; the exported applyPlaybackToPlayer
  // below serializes it (see applyInFlightRef) so concurrent invocations
  // during a recovery cannot destroy each other's fresh player instance.
  const applyPlaybackToPlayerInner = useCallback(
    async (playback, track) => {
      const player = playerRef.current;
      if (!player || !playback || !track) return;

      const isLocalAudio = player instanceof LocalAudioPlayer;
      if (isLocalAudio && playback.durationMs > 0) player.setDuration(playback.durationMs);

      const trackKey = `${track.id}:${playback.trackVersion}`;
      const signature = computePlaybackSignature(track, playback);
      // R1 (follow-up): the same playback command re-broadcast? room:state
      // arrives ~every second and re-runs the effect that calls this, so
      // without this check every broadcast re-issued play()/seek() — each
      // one restarted the YouTube load, so a first Play never finished
      // buffering, and each one cleared the stall watchdog before it could
      // fire. Only re-apply when the player is actually in the wrong state.
      // A scheduled play already queued is never disturbed either.
      if (
        loadedTrackKeyRef.current === trackKey &&
        lastAppliedPlaybackRef.current === signature
      ) {
        if (scheduledPlayTimerRef.current) return;
        let liveState = null;
        try {
          liveState = await player.getState();
        } catch {
          liveState = null;
        }
        if (
          !shouldReapplyPlayback({
            signature,
            lastSignature: lastAppliedPlaybackRef.current,
            trackKey,
            lastTrackKey: loadedTrackKeyRef.current,
            livePlayerState: liveState,
            playbackState: playback.playbackState,
          })
        ) {
          return;
        }
        // Else fall through: the player is paused while the room plays (or
        // playing while the room is paused) and genuinely needs the command.
      }
      lastAppliedPlaybackRef.current = signature;

      // Cancel any pending scheduled play so a stale timeout cannot
      // seek + play on an old state after a newer one arrives.
      if (scheduledPlayTimerRef.current) {
        clearTimeout(scheduledPlayTimerRef.current);
        scheduledPlayTimerRef.current = null;
      }
      // A newer playback state supersedes any stall watch on the old one.
      if (playWatchdogTimerRef.current) {
        clearTimeout(playWatchdogTimerRef.current);
        playWatchdogTimerRef.current = null;
      }
      playWatchdogAttemptRef.current = 0;

      // R1: first-play stall watchdog. If the room is playing but the local
      // player still has not started ~4s after we told it to play (and its
      // position has not advanced), retry play() once; if it still has not
      // started ~4s later, surface a real error instead of spinning on
      // "Loading…"/"Buffering" forever. Cleared by onStateChange('playing')
      // and by any newer playback state (above).
      const armStallWatchdog = (anchorMs) => {
        const check = async () => {
          playWatchdogTimerRef.current = null;
          if (playerRef.current !== player) return;
          const p = playerRef.current;
          const st = roomStateRef.current;
          if (!p || !st?.playback || st.playback.playbackState !== 'playing') return;
          let state = 'idle';
          let pos = 0;
          try {
            state = await p.getState();
          } catch {
            // Treat as stalled below
          }
          try {
            pos = await p.getPosition();
          } catch {
            // Treat as stalled below
          }
          if (state === 'playing' || pos - anchorMs >= 500) return;
          if (playWatchdogAttemptRef.current < 1) {
            playWatchdogAttemptRef.current += 1;
            try {
              await p.play();
            } catch {
              // Second check below will surface the error
            }
            // E-20: second attempt gets more time (8s) on slow mobile networks
            playWatchdogTimerRef.current = setTimeout(check, 8000);
            return;
          }
          setPlayerError({
            code: 'PLAY_STALLED',
            message:
              'Playback didn’t start — the video may still be loading or blocked. Try tapping Play again, or press Next.',
          });
        };
        // E-20: initial timeout increased from 4s to 6s for slow networks
        playWatchdogTimerRef.current = setTimeout(check, 6000);
      };

      const estimatedNow = clockSyncRef.current.estimateServerNowMs();
      const expectedMs = computeExpectedPositionMs(playback, estimatedNow);

      if (loadedTrackKeyRef.current !== trackKey) {
        loadedTrackKeyRef.current = trackKey;
        realDurationRef.current = 0;
        lastReportedDurationRef.current = 0;
        setPlayerError(null);
        // E-25: immediately reset sync metrics so scrubber and clock show 00:00 (expectedMs)
        // on track switch without lingering on the previous track's position.
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(expectedMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: 0,
        }));
        // B1: pass shouldPlay so YouTube uses loadVideoById (loads AND plays)
        // instead of cueVideoById (loads paused, losing the immediate play()).
        const shouldPlay = playback.playbackState === 'playing' && (!isLocalAudio || audioUnlockedRef.current);
        const trackToLoad = isLocalAudio && playback.durationMs > 0
          ? { ...track, durationSec: playback.durationMs / 1000 }
          : track;
        await player.loadTrack(trackToLoad, expectedMs, shouldPlay);
        // R5: do NOT report the real duration here — loadTrack returns
        // before the new video finishes loading, so getDuration() still
        // returns the PREVIOUS track's length and would corrupt the new
        // track's duration server-side. The 1s drift loop reports it once
        // the player is confirmed to be on the new track.
        if (shouldPlay && playerRef.current === player) armStallWatchdog(expectedMs);
        // B1 (follow-up): loadVideoById is asynchronous — the new video has
        // NOT finished loading when loadTrack returns. The seek/play sync
        // below would therefore operate on the OLD video still loaded in the
        // player (seeking it to the new track's position and pinning it
        // there), which is exactly why Next left the old song playing for
        // minutes. loadVideoById already plays the new video at the right
        // start position, so return here and let the drift loop fine-tune
        // the position once the new video is actually loaded.
        return;
      }

      if (!audioUnlockedRef.current || playerRef.current !== player) return;

      backgroundAudio.updateMetadata(track);
      await backgroundAudio.setPlaying(playback.playbackState === 'playing');

      if (playback.playbackState === 'playing') {
        const delayMs =
          typeof playback.effectiveAtServerMs === 'number'
            ? Math.max(0, playback.effectiveAtServerMs - estimatedNow)
            : 0;

        if (delayMs > 20 && delayMs < 3000) {
          scheduledPlayTimerRef.current = setTimeout(async () => {
            scheduledPlayTimerRef.current = null;
            if (playerRef.current !== player) return;
            await player.seek(playback.anchorPositionMs || 0);
            await player.play();
            armStallWatchdog(playback.anchorPositionMs || 0);
          }, delayMs);
        } else {
          const currentPos = await player.getPosition();
          if (Math.abs(currentPos - expectedMs) > 450) {
            await player.seek(expectedMs);
          }
          await player.play();
          // R1: the first Play after a cue is the stall case — watch it.
          armStallWatchdog(expectedMs);
        }
      } else {
        await player.pause();
        const currentPos = await player.getPosition();
        if (Math.abs(currentPos - expectedMs) > 250) {
          await player.seek(expectedMs);
        }
      }
    },
    []
  );

  // Round 4: serialized wrapper around applyPlaybackToPlayerInner. The
  // B1 effect fires on every room:state broadcast (~every second), and
  // onError resets the dedup signature — so during a recovery the effect
  // can re-enter while a previous invocation is still awaiting
  // recoverIfFailed()/initialize(). A concurrent invocation could
  // destroy a just-created player or double-issue the load. A skipped
  // invocation is safe: the next broadcast (~1s later) retries it with
  // the latest state.
  const applyPlaybackToPlayer = useCallback(
    async (playback, track) => {
      if (applyInFlightRef.current) return;
      applyInFlightRef.current = true;
      try {
        await applyPlaybackToPlayerInner(playback, track);
      } finally {
        applyInFlightRef.current = false;
      }
    },
    [applyPlaybackToPlayerInner]
  );

  // Initialize / switch player adapter when source or container changes
  const initPlayerForSource = useCallback(
    async (source, containerEl) => {
      const wantsYouTube = source === 'youtube';
      const version = ++playerInitVersionRef.current;
      const isCurrent = () => version === playerInitVersionRef.current;
      playerContainerRef.current = containerEl;
      const previousPlayer = playerRef.current;
      playerRef.current = null;
      loadedTrackKeyRef.current = null;
      lastAppliedPlaybackRef.current = null;
      for (const timer of [scheduledPlayTimerRef, playWatchdogTimerRef]) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (previousPlayer) await previousPlayer.destroy();
      if (!isCurrent() || (wantsYouTube && !containerEl)) return;

      const callbacks = {
        onReady: () => {
          if (!isCurrent()) return;
          if (sessionRef.current) {
            emitAck('player:ready', { ready: true }).catch(() => {});
          }
        },
        onStateChange: (state) => {
          if (!isCurrent()) return;
          // R4: the local player is the ground truth for the status pill /
          // Play button — record it here (and in the 1s poll) instead of
          // relying on the server's lagging buffering/paused flags.
          playerStateRef.current = state;
          setPlayerState(state);
          if (state === 'playing') {
            // Round 4 (d): the "Playback didn't start" banner stayed
            // visible even while playback was genuinely advancing —
            // playerError was only cleared on track change / re-init /
            // manual dismiss. A real PLAYING state means the player
            // recovered, so clear it here.
            setPlayerError(null);
          }
          if (state === 'playing' && playWatchdogTimerRef.current) {
            clearTimeout(playWatchdogTimerRef.current);
            playWatchdogTimerRef.current = null;
            playWatchdogAttemptRef.current = 0;
          }
          if (
            state === 'paused' &&
            typeof document !== 'undefined' &&
            document.hidden &&
            roomStateRef.current?.playback?.playbackState === 'playing' &&
            audioUnlockedRef.current
          ) {
            // Keep audio playing when the mobile browser is minimized or backgrounded
            setTimeout(() => {
              if (!isCurrent()) return;
              // N-33: re-check hidden INSIDE the timeout — if the tab is still
              // hidden, do not retry (otherwise this loops while backgrounded).
              if (typeof document !== 'undefined' && document.hidden) return;
              if (roomStateRef.current?.playback?.playbackState === 'playing') {
                playerRef.current?.play().catch(() => {});
              }
            }, 80);
          }
          if (sessionRef.current) {
            emitAck('player:status', { buffering: state === 'buffering' }).catch(() => {});
          }
        },
        onEnded: () => {
          if (!isCurrent()) return;
          const st = roomStateRef.current;
          if (sessionRef.current && st?.playback) {
            emitAck('player:status', {
              endedTrackVersion: st.playback.trackVersion,
            }).catch(() => {});
          }
        },
        onError: (err) => {
          if (!isCurrent()) return;
          setPlayerError(err);
          // F1: a failed load must not stay "already applied" in the dedup:
          // the next effect run has to re-issue the load (on a recovered
          // player), not conclude the command is done. Reset the applied
          // signature; the track key stays (same track), so the effect
          // re-applies via play(), which recovers the player if needed.
          lastAppliedPlaybackRef.current = null;
          // F1: an embedding-disabled / removed video will never play — the
          // specific error is already shown, so the stall watchdog must not
          // overwrite it with a generic "Playback didn't start" after its
          // retry. (Non-embed errors keep the watchdog's one retry.)
          if (err?.isEmbedBlocked && playWatchdogTimerRef.current) {
            clearTimeout(playWatchdogTimerRef.current);
            playWatchdogTimerRef.current = null;
            playWatchdogAttemptRef.current = 0;
          }
        },
      };

      const adapter = wantsYouTube
        ? new YouTubePlayer(callbacks)
        : source === 'spotify'
          ? new SpotifyPlayer(callbacks)
          : new LocalAudioPlayer(callbacks);

      try {
        await adapter.initialize(containerEl);
        if (!isCurrent()) {
          await adapter.destroy();
          return;
        }
        playerRef.current = adapter;
        if (adapter instanceof LocalAudioPlayer && adapter.needsAudioGesture()) {
          audioUnlockedRef.current = false;
          setAudioUnlocked(false);
        }
        // M3: apply the stored volume/muted state to the new player.
        try {
          await adapter.setVolume?.(volumeRef.current);
          if (mutedRef.current) await adapter.setMuted?.(true);
        } catch {
          // Ignore — volume can be re-applied later via setVolume/toggleMute
        }
        if (!isCurrent()) return;
        setPlayerError(null);

        const st = roomStateRef.current;
        const trk =
          st?.queue?.find((q) => q.queueItemId === st.currentQueueItemId)?.track ||
          st?.queue?.[0]?.track;
        if (st?.playback && trk) {
          await applyPlaybackToPlayer(st.playback, trk);
        }
      } catch (err) {
        if (playerRef.current !== adapter) await adapter.destroy();
        if (isCurrent()) setPlayerError({ code: 'INIT_FAILED', message: err.message });
      }
    },
    [applyPlaybackToPlayer]
  );

  // N-04: adopt a room from a room:create ack or a room:created event.
  const adoptCreatedRoom = useCallback(
    async (res) => {
      if (!res?.ok) return res;
      const nextSession = {
        roomCode: res.roomCode,
        participantId: res.participantId,
        sessionToken: res.sessionToken,
        role: res.role,
      };
      setSession(nextSession);
      saveSession(nextSession);
      // F2: this socket is adopted from here on — commands may be sent.
      adoptedRef.current = true;
      setRoomState(res.state);
      seedPositionFromPlayback(res.state?.playback);
      setAudioUnlocked(true);
      await runClockSync();
      return res;
    },
    [runClockSync, seedPositionFromPlayback]
  );

  // Setup Socket.IO listeners
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setConnectionStatus('connected');
      runClockSync();
      // N-03: auto-reconnect whenever we have an active session — on a fresh
      // page load AND after a mid-room network blip. The old
      // `!roomStateRef.current` guard blocked the mid-room case entirely:
      // roomState was already set, so no room:reconnect was ever sent and
      // every command then failed NOT_IN_ROOM.
      const cur = sessionRef.current || loadSession();
      if (cur?.roomCode && cur?.sessionToken) {
        emitAck('room:reconnect', {
          roomCode: cur.roomCode,
          sessionToken: cur.sessionToken,
        })
          .then(async (res) => {
            if (res?.ok) {
              const nextSession = {
                roomCode: res.roomCode,
                participantId: res.participantId,
                sessionToken: res.sessionToken,
                role: res.role,
              };
              setSession(nextSession);
              saveSession(nextSession);
              // F2: the re-adoption succeeded — this socket may send commands.
              adoptedRef.current = true;
              setRoomState(res.state);
              // R6: adopt the room's current position/theme at once, and
              // re-fetch the authoritative snapshot in case a broadcast
              // (e.g. a theme change) landed while the socket was down.
              seedPositionFromPlayback(res.state?.playback);
              refreshRoomStateFromServer();
              await runClockSync();
              const trk =
                res.state?.queue?.find((q) => q.queueItemId === res.state.currentQueueItemId)
                  ?.track || res.state?.queue?.[0]?.track;
              if (res.state?.playback && trk) {
                await applyPlaybackToPlayer(res.state.playback, trk);
              }
            } else {
              clearSession();
            }
          })
          .catch(() => {});
      }
    };

    const onDisconnect = () => {
      setConnectionStatus('reconnecting');
      // F2: this socket is no longer adopted — the server attached the
      // participant to the OLD socket id. Commands must wait for the
      // re-adoption (room:reconnect) instead of failing NOT_IN_ROOM.
      adoptedRef.current = false;
      setSyncMetrics((prev) => ({ ...prev, reconnectCount: prev.reconnectCount + 1 }));
    };

    const onRoomState = (nextState) => {
      // R3: the partner's player reports its position to the server about
      // every second, and the server rebroadcasts it here. A moving
      // reportedPositionMs (or a changed ready/buffering) proves the
      // partner's socket is live even if their `connected` flag in this
      // same state still says disconnected after a transient blip.
      const prev = roomStateRef.current;
      if (prev && sessionRef.current) {
        const prevPartner = (prev.participants || []).find(
          (p) => p.id !== sessionRef.current.participantId
        );
        const nextPartner = (nextState.participants || []).find(
          (p) => p.id !== sessionRef.current.participantId
        );
        if (nextPartner && prevPartner) {
          if (
            nextPartner.connected ||
            nextPartner.reportedPositionMs !== prevPartner.reportedPositionMs ||
            nextPartner.ready !== prevPartner.ready ||
            nextPartner.buffering !== prevPartner.buffering
          ) {
            markPartnerSeen();
          }
        } else if (nextPartner?.connected) {
          markPartnerSeen();
        }
      }
      setRoomState(nextState);
      if (sessionRef.current) {
        const me = nextState.participants.find((p) => p.id === sessionRef.current.participantId);
        if (me && me.role !== sessionRef.current.role) {
          const updated = { ...sessionRef.current, role: me.role };
          setSession(updated);
          saveSession(updated);
        }
      }
    };

    const onPlaybackState = (playback) => {
      // R3: when the partner is the host, a playback state is their command
      // arriving — proof they are live. (When I am host it is my own echo,
      // so it proves nothing about the partner.)
      const partner = roomStateRef.current?.participants?.find(
        (p) => sessionRef.current && p.id !== sessionRef.current.participantId
      );
      if (partner?.role === 'host') markPartnerSeen();
      // B1 (root cause): this used to derive the track from
      // roomStateRef.current and call applyPlaybackToPlayer here. But the
      // server emits playback:state BEFORE queue:updated, so at this moment
      // currentQueueItemId is still the PREVIOUS track while `playback`
      // already carries the NEW trackVersion — applyPlaybackToPlayer then
      // loaded the OLD video with the new track's position, and the player
      // lagged one track behind forever. So this handler only updates the
      // state; the effect below (which reads the track from the latest
      // roomState, after queue:updated lands) is the single place that
      // drives the player.
      if (playback?.trackVersion !== roomStateRef.current?.playback?.trackVersion) {
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: 0,
          expectedPositionMs: 0,
          driftMs: 0,
        }));
      }
      setRoomState((prev) => (prev ? { ...prev, playback } : prev));
    };

    const onQueueUpdated = ({ queue, currentQueueItemId }) => {
      // R3: same host-command liveness signal as onPlaybackState.
      const partner = roomStateRef.current?.participants?.find(
        (p) => sessionRef.current && p.id !== sessionRef.current.participantId
      );
      if (partner?.role === 'host') markPartnerSeen();
      setRoomState((prev) => (prev ? { ...prev, queue, currentQueueItemId } : prev));
    };

    const onChatMessage = (msg) => {
      // R3: a chat message from the partner is their socket talking.
      if (msg.senderId !== sessionRef.current?.participantId) {
        markPartnerSeen();
      }
      setRoomState((prev) => {
        if (!prev) return prev;
        return { ...prev, chat: [...(prev.chat || []), msg].slice(-100) };
      });
      if (msg.senderId !== sessionRef.current?.participantId) {
        setUnreadChatCount((c) => c + 1);
      }
    };

    const onPartnerTyping = ({ participantId }) => {
      if (participantId !== sessionRef.current?.participantId) {
        markPartnerSeen();
        setPartnerTyping(true);
        if (partnerTypingTimerRef.current) clearTimeout(partnerTypingTimerRef.current);
        partnerTypingTimerRef.current = setTimeout(() => setPartnerTyping(false), 2500);
      }
    };

    const onReactionBurst = (burst) => {
      // R3: a reaction from the partner is their socket talking.
      if (burst.senderId !== sessionRef.current?.participantId) {
        markPartnerSeen();
      }
      setReactions((prev) => [...prev.slice(-12), burst]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== burst.id));
      }, 2600);
    };

    const onRoomClosed = ({ reason }) => {
      setRoomError(reason || 'Room closed');
      setPendingApproval(null);
      adoptedRef.current = false;
      setRoomState(null);
      setSession(null);
      clearSession();
    };

    const onRoomJoined = (res) => {
      if (!res?.ok) return;
      const nextSession = {
        roomCode: res.roomCode,
        participantId: res.participantId,
        sessionToken: res.sessionToken,
        role: res.role,
      };
      setPendingApproval(null);
      setSession(nextSession);
      saveSession(nextSession);
      // F2: the server just adopted this socket (join, reconnect, or an
      // approved join) — commands may be sent from here on.
      adoptedRef.current = true;
      setRoomState(res.state);
      // R6: adopt the room's current position immediately on (re)join —
      // before any audio-unlock tap. The theme comes from res.state
      // (roomState.settings.theme) and is therefore adopted at the same
      // moment; the unlock tap only unlocks audio, it must not be the
      // trigger for adopting position/theme.
      seedPositionFromPlayback(res.state?.playback);
      // The server also emits room:joined for room:reconnect. A mid-room
      // reconnect must NOT reset audioUnlocked (the user already tapped);
      // only a genuinely new join starts locked.
      const isReconnect =
        roomStateRef.current && sessionRef.current?.roomCode === res.roomCode;
      if (!isReconnect) setAudioUnlocked(false);
      runClockSync();
    };

    // N-04: if room:created arrives while a create is pending, adopt that
    // room and resolve the pending create instead of orphaning it.
    const onRoomCreated = (res) => {
      const pending = pendingCreateRef.current;
      if (!pending || !res?.ok) return;
      pendingCreateRef.current = null;
      adoptCreatedRoom(res).then(() => {
        pending.resolve(res);
      });
    };

    const onJoinDeclined = ({ error }) => {
      setPendingApproval(null);
      setRoomError(error || 'Host declined your join request');
    };

    // R3: the server emits connection:status { participantId, connected }
    // when a socket drops — but only the `false` side, never a `true` on
    // reconnect. So this event is advisory only: a `true` marks the
    // partner seen, while a `false` must NOT flip the indicator at once —
    // a transient drop would show "Disconnected" while the partner's
    // events keep flowing. The derived presence (server flag + recent
    // partner traffic + grace window) decides instead.
    const onConnectionStatus = ({ participantId, connected }) => {
      if (connected && participantId !== sessionRef.current?.participantId) {
        markPartnerSeen();
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connection:status', onConnectionStatus);
    socket.on('room:state', onRoomState);
    socket.on('room:created', onRoomCreated);
    socket.on('room:joined', onRoomJoined);
    socket.on('room:join-declined', onJoinDeclined);
    socket.on('playback:state', onPlaybackState);
    socket.on('playback:scheduled', onPlaybackState);
    socket.on('queue:updated', onQueueUpdated);
    socket.on('chat:message', onChatMessage);
    socket.on('chat:typing', onPartnerTyping);
    socket.on('reaction:burst', onReactionBurst);
    socket.on('room:closed', onRoomClosed);

    // E-01: listen for the host:promoted event from the server so the guest
    // learns they became host after the original host disconnected.
    const onHostPromoted = ({ reason }) => {
      if (sessionRef.current) {
        const updated = { ...sessionRef.current, role: 'host' };
        setSession(updated);
        saveSession(updated);
      }
      // Surface the promotion as a room-level notification the UI can show.
      setRoomError(reason || 'You are now the host.');
    };
    socket.on('host:promoted', onHostPromoted);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connection:status', onConnectionStatus);
      socket.off('room:state', onRoomState);
      socket.off('room:created', onRoomCreated);
      socket.off('room:joined', onRoomJoined);
      socket.off('room:join-declined', onJoinDeclined);
      socket.off('playback:state', onPlaybackState);
      socket.off('playback:scheduled', onPlaybackState);
      socket.off('queue:updated', onQueueUpdated);
      socket.off('chat:message', onChatMessage);
      socket.off('chat:typing', onPartnerTyping);
      socket.off('reaction:burst', onReactionBurst);
      socket.off('room:closed', onRoomClosed);
      socket.off('host:promoted', onHostPromoted);
    };
  }, [
    applyPlaybackToPlayer,
    runClockSync,
    adoptCreatedRoom,
    markPartnerSeen,
    seedPositionFromPlayback,
    refreshRoomStateFromServer,
  ]);

  // R3: re-evaluate derived presence every 2s while a partner is in the
  // room, so a genuinely gone partner flips to disconnected once the grace
  // window expires even when no further room event arrives.
  useEffect(() => {
    if (!roomState || (roomState.participants || []).length < 2) return;
    const id = setInterval(() => setPresenceTickMs(Date.now()), 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomState?.participants?.length]);

  // B1: the single place that drives the player from the room state.
  // Whenever the playback state or the current track changes, apply it to
  // the player using the track read from the LATEST roomState (so a track
  // change is never applied with a stale currentQueueItemId). This covers
  // Next/Previous, play/pause, seek and track-end advance.
  useEffect(() => {
    if (!roomState?.playback || !currentTrack) return;
    applyPlaybackToPlayer(roomState.playback, currentTrack).catch(() => {});
  }, [applyPlaybackToPlayer, roomState?.playback, currentTrack]);

  // Periodic drift measurement & correction loop (every 1000ms while playing)
  useEffect(() => {
    if (!roomState || !audioUnlocked) return;
    const interval = setInterval(async () => {
      const player = playerRef.current;
      const st = roomStateRef.current;
      if (!player || !st?.playback) return;

      const actualMs = await player.getPosition();
      const estimatedNow = clockSyncRef.current.estimateServerNowMs();
      const expectedMs = computeExpectedPositionMs(st.playback, estimatedNow);

      // R4: poll the REAL player state every tick. onStateChange events can
      // be missed/coalesced and the server's buffering/paused flags lag, so
      // the pill/button must not trust either alone: if the position is
      // advancing while the player claims to be buffering/paused, it is
      // playing. (Position is also read by the watchdog; keep the ref fresh.)
      const prevPos = lastPlayerPositionRef.current;
      const positionAdvanced = actualMs - prevPos >= 500;
      lastPlayerPositionRef.current = actualMs;
      // R1 (follow-up): the polled state, hoisted so the seek guard below
      // can see it — a player that has not started this track yet must
      // never be seek-corrected.
      let effectivePlayerState = null;
      try {
        const polled = await player.getState();
        if (polled) {
          let effective = polled;
          if (
            (effective === 'buffering' || effective === 'paused') &&
            positionAdvanced &&
            st.playback.playbackState === 'playing'
          ) {
            effective = 'playing';
          }
          effectivePlayerState = effective;
          if (effective !== playerStateRef.current) {
            playerStateRef.current = effective;
            setPlayerState(effective);
          }
        }
      } catch {
        // Ignore — next tick retries; onStateChange is the other source.
      }

      // B1: which media the player has ACTUALLY loaded (computed once, used
      // by both the duration report below and the seek guard further down).
      let loadedId = null;
      try {
        loadedId = typeof player.getLoadedVideoId === 'function' ? await player.getLoadedVideoId() : null;
      } catch {
        loadedId = null;
      }
      const curTrack =
        st.queue?.find((q) => q.queueItemId === st.currentQueueItemId)?.track ||
        st.queue?.[0]?.track ||
        null;
      const mySource =
        st.participants?.find((p) => sessionRef.current && p.id === sessionRef.current.participantId)?.source ||
        myParticipant?.source ||
        'youtube';
      const expectedId = expectedMediaId(curTrack, mySource);

      // N-02/B2: read the real duration every tick; report it to the server
      // when it differs from the stored one, and never seek the player back
      // when it is within 1500ms of its real end (let onEnded fire).
      // R5: only report once the player is confirmed to be on THIS track —
      // reporting while it still holds the previous video overwrites the new
      // track's duration with the old one (04:04 for Instant Crush).
      let realDurationMs = 0;
      try {
        realDurationMs = await player.getDuration();
      } catch {
        realDurationMs = 0;
      }
      if (realDurationMs > 0 && !(player instanceof LocalAudioPlayer)) {
        // Round 4 (a): only report once the player has actually started
        // this track — an errored player's getDuration() returns the
        // failed video's YouTube length, which would corrupt the queue
        // item's stored duration.
        reportRealDuration(realDurationMs, st.playback, {
          loadedId,
          expectedId,
          playerStarted: playerHasStarted(effectivePlayerState),
        });
      }

      // B1: do NOT seek when the player is still on the previous track.
      // After Next, loadVideoById takes a moment to swap the video; until
      // it does, the player's position/duration belong to the OLD video and
      // any seek here would pin the old video in place (and stop the new
      // one from ever loading). Compare the actually-loaded media ID with
      // the current track's ID and skip the correction until they match.
      // (loadedId / expectedId were computed above, before the duration
      // report, so the report and the seek share one reading.)
      if (loadedId && expectedId && loadedId !== expectedId) {
        // E-25: report position as 0 (not the old video's position) so the
        // UI progress bar doesn't show the previous track's position while
        // the new track is loading.
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(expectedMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: 0,
        }));
        return;
      }

      if (st.playback.playbackState !== 'playing') {
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(actualMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: Math.round(actualMs - expectedMs),
        }));
        return;
      }

      const evaluation = evaluateDriftCorrection({
        expectedMs,
        actualMs,
        lastCorrectionAtMs: lastCorrectionAtRef.current,
        consecutiveModerateCount: consecutiveDriftRef.current,
        playerDurationMs: realDurationMs > 0 ? realDurationMs : realDurationRef.current || null,
      });

      consecutiveDriftRef.current = evaluation.nextConsecutiveCount;

      if (evaluation.action === 'seek') {
        // R1 (follow-up): never seek a player that has not started this
        // track yet. While the video is still cueing/buffering its position
        // sits at 0 while the expected position grows, so the drift loop
        // would seek it every ~1.5s — each seek disturbs the load and the
        // video never starts. Report the position, but do not seek and do
        // not count a correction. (A player whose position is advancing is
        // 'playing' by the overrule above, so real drift still corrects.)
        if (!playerHasStarted(effectivePlayerState)) {
          setSyncMetrics((prev) => ({
            ...prev,
            reportedPositionMs: Math.round(actualMs),
            expectedPositionMs: Math.round(expectedMs),
            driftMs: evaluation.driftMs,
          }));
        } else {
          lastCorrectionAtRef.current = Date.now();
          await player.seek(evaluation.targetMs);
          setSyncMetrics((prev) => ({
            ...prev,
            reportedPositionMs: Math.round(evaluation.targetMs),
            expectedPositionMs: Math.round(expectedMs),
            driftMs: evaluation.driftMs,
            correctionCount: prev.correctionCount + 1,
          }));
        }
      } else {
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(actualMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: evaluation.driftMs,
        }));
      }

      emitAck('player:status', {
        reportedPositionMs: Math.round(actualMs),
        driftMs: evaluation.driftMs,
      }).catch(() => {});
    }, 1000);

    return () => clearInterval(interval);
  }, [roomState, audioUnlocked]);

  // M8: keep syncMetrics.expectedPositionMs fresh even when audio is not
  // unlocked yet (the drift loop above only runs when audioUnlocked, which
  // is why a guest's reported position went stale before tapping). The UI
  // subagent uses this for the guest's read-only progress bar.
  useEffect(() => {
    if (!roomState) return;
    const updateExpected = () => {
      const st = roomStateRef.current;
      if (!st?.playback) return;
      const expectedMs = computeExpectedPositionMs(
        st.playback,
        clockSyncRef.current.estimateServerNowMs()
      );
      // R6: while audio is still locked the player has not reported a
      // position yet, so mirror the room's expected position into the
      // reported one — the progress UI reads the reported value, and a
      // guest rejoining a room paused at 00:55 must see 00:55 before
      // tapping to unlock audio. Once unlocked the drift loop owns the
      // reported position and this stays out of its way.
      // Round 4 (b) + E-22: never mirror into the reported position while
      // the player is errored OR while nothing is actually playing. The
      // room clock keeps advancing while the video is unavailable or
      // before playback starts, so mirroring made the progress clock
      // advance (00:25, 00:33…) with no actual playback. The reported
      // position then stays at the last real player position (frozen),
      // which is honest.
      const mirrorReported =
        !audioUnlockedRef.current &&
        playerStateRef.current !== 'error' &&
        (st.playback.playbackState === 'playing' || st.playback.playbackState === 'buffering');
      setSyncMetrics((prev) =>
        mirrorReported
          ? {
              ...prev,
              expectedPositionMs: Math.round(expectedMs),
              reportedPositionMs: Math.round(expectedMs),
            }
          : { ...prev, expectedPositionMs: Math.round(expectedMs) }
      );
    };
    updateExpected();
    const interval = setInterval(updateExpected, 1000);
    return () => clearInterval(interval);
  }, [roomState]);

  // Visibility-change reconciliation (mobile foreground recovery)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && sessionRef.current) {
        runClockSync();
        // R6: the server answers sync:request with the full current room
        // state — adopt it (version-guarded) instead of dropping it, so a
        // theme/position change missed while hidden is picked up on return.
        refreshRoomStateFromServer();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // I-04: send a leave signal when the tab is closing. The browser fires
    // `pagehide` (preferred for bfcache, mobile Safari) or `beforeunload`
    // (desktop fallback). Socket.IO may send a close frame, but neither
    // guarantees the server learns the person is gone quickly. This handler
    // gives the server the best possible advance notice.
    const onPageHide = () => {
      const socket = getSocket();
      if (socket?.connected && sessionRef.current) {
        // Use the low-level `send` path — the tab is tearing down, so we
        // cannot await an ack. `volatile` ensures Socket.IO does not queue
        // the event when the transport is already gone.
        socket.volatile.emit('room:tab-close', {});
        try {
          socket.disconnect();
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
    };
  }, [runClockSync, refreshRoomStateFromServer]);

  const createRoom = useCallback(async ({ name = 'Host', source = 'youtube' } = {}) => {
    setRoomError(null);
    setConnectionStatus('connecting');
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    // N-04: 60s ack timeout (Render cold start is ~30–60s; the old 6s
    // timeout orphaned rooms). The room:created listener resolves the
    // pending promise if that event arrives first.
    const ackPromise = emitAck(
      'room:create',
      {
        name,
        source,
        initialTracks: INITIAL_TRACKS.slice(0, 3),
      },
      60000
    );
    // Avoid an unhandled rejection if the pending promise wins the race.
    ackPromise.catch(() => {});
    let pendingResolve;
    const pendingPromise = new Promise((resolve) => {
      pendingResolve = resolve;
    });
    pendingCreateRef.current = { resolve: pendingResolve };

    let res;
    try {
      res = await Promise.race([ackPromise, pendingPromise]);
    } catch (err) {
      pendingCreateRef.current = null;
      setRoomError(err?.message || 'Failed to create room');
      throw err;
    }
    pendingCreateRef.current = null;
    if (!res?.ok) {
      setRoomError(res?.error || 'Failed to create room');
      throw new Error(res?.error || 'Failed to create room');
    }

    // If the room:created listener already adopted the room, the session is
    // set; adopt again only if it did not (idempotent by roomCode check).
    if (sessionRef.current?.roomCode !== res.roomCode || !roomStateRef.current) {
      await adoptCreatedRoom(res);
    }
    return res;
  }, [adoptCreatedRoom]);

  const joinRoom = useCallback(async ({ roomCode, name = 'Guest', source = 'youtube', sessionToken }) => {
    setRoomError(null);
    setConnectionStatus('connecting');
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    const res = await emitAck('room:join', {
      roomCode: roomCode.trim().toUpperCase(),
      name,
      source,
      // M4: forward a stored session token so the server can reuse the
      // existing participant instead of reporting the room as full.
      ...(sessionToken ? { sessionToken } : {}),
    });
    if (!res?.ok) {
      setRoomError(res?.error || 'Failed to join room');
      throw new Error(res?.error || 'Failed to join room');
    }

    if (res.pendingApproval) {
      setPendingApproval({ roomCode: res.roomCode, requestId: res.requestId });
      return res;
    }

    const nextSession = {
      roomCode: res.roomCode,
      participantId: res.participantId,
      sessionToken: res.sessionToken,
      role: res.role,
    };
    setSession(nextSession);
    saveSession(nextSession);
    // F2: the join ack means the server adopted this socket.
    adoptedRef.current = true;
    setRoomState(res.state);
    // R6: adopt the room's current position/theme at once, and re-fetch
    // the authoritative snapshot in case a broadcast landed mid-join.
    seedPositionFromPlayback(res.state?.playback);
    refreshRoomStateFromServer();
    setAudioUnlocked(false); // Mobile guest requires gesture unlock
    await runClockSync();
    return res;
  }, [runClockSync, seedPositionFromPlayback, refreshRoomStateFromServer]);

  const leaveRoom = useCallback(async () => {
    playerInitVersionRef.current += 1;
    try {
      await emitAck('room:leave', {});
    } catch {
      // Ignore
    }
    if (playerRef.current) {
      await playerRef.current.destroy();
      playerRef.current = null;
      loadedTrackKeyRef.current = null;
      lastAppliedPlaybackRef.current = null;
    }
    backgroundAudio.destroy();
    clearSession();
    setSession(null);
    setRoomState(null);
    // F2: no room, no adoption — a later command must not assume the old
    // socket is still adopted.
    adoptedRef.current = false;
    setAudioUnlocked(false);
    setPlayerError(null);
  }, []);

  const unlockAudio = useCallback(async () => {
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;
    const player = playerRef.current;
    if (player instanceof LocalAudioPlayer) {
      const [unlocked] = await Promise.all([player.unlockAudio(), backgroundAudio.unlock()]);
      if (!unlocked && playerRef.current === player) {
        audioUnlockedRef.current = false;
        setAudioUnlocked(false);
        return;
      }
    } else {
      await backgroundAudio.unlock();
    }
    await emitAck('player:ready', { ready: true }).catch(() => {});
    const st = roomStateRef.current;
    if (st?.playback && currentTrack) {
      await applyPlaybackToPlayer(st.playback, currentTrack);
    }
  }, [applyPlaybackToPlayer, currentTrack]);

  // Round 4: full in-app player reset — what a page reload does, without
  // reloading the page. Called by the error banner's "Reload player"
  // button. Destroys the player, clears ALL failure/marker state
  // (including the once-per-video recovery bound that made the player
  // stay dead after one error), re-initializes a fresh instance, then
  // re-applies the current playback. Returns true when the player is
  // usable again.
  const reloadPlayer = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return false;
    setPlayerError(null);
    // A fresh instance has nothing applied yet — force a full re-apply.
    lastAppliedPlaybackRef.current = null;
    loadedTrackKeyRef.current = null;
    let ok = false;
    try {
      if (typeof player.reloadPlayer === 'function') {
        ok = await player.reloadPlayer();
      } else {
        // Adapters without reloadPlayer (Spotify / local audio): full
        // re-initialization via initPlayerForSource.
        const st = roomStateRef.current;
        const source =
          st?.participants?.find((p) => sessionRef.current && p.id === sessionRef.current.participantId)?.source ||
          myParticipant?.source ||
          'youtube';
        await initPlayerForSource(source, playerContainerRef.current);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      setPlayerError({
        code: 'INIT_FAILED',
        message: 'The player could not be reloaded — try refreshing the page.',
        isEmbedBlocked: false,
      });
      return false;
    }
    const st = roomStateRef.current;
    const trk =
      st?.queue?.find((q) => q.queueItemId === st.currentQueueItemId)?.track ||
      st?.queue?.[0]?.track ||
      null;
    if (st?.playback && trk) {
      await applyPlaybackToPlayer(st.playback, trk);
    }
    return true;
  }, [applyPlaybackToPlayer, initPlayerForSource, myParticipant?.source]);

  // F2: wait (bounded) for this socket to be adopted into the room before
  // emitting a command. After a refresh or a mid-room socket drop, the
  // socket is connected but the server has not yet processed room:reconnect
  // — a command sent in that window fails NOT_IN_ROOM /
  // PARTICIPANT_NOT_FOUND and (for chat) the message is lost. No session
  // means no room (demo / landing), so send as before.
  const waitForAdoption = useCallback(async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!adoptedRef.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return adoptedRef.current;
  }, []);

  const sendCommand = useCallback(async (event, payload = {}) => {
    if (sessionRef.current && !adoptedRef.current) {
      await waitForAdoption();
    }
    // F2: the roomVersion is read fresh per attempt — a retry after a
    // membership error must not send the stale version from the first
    // attempt (the store rejects stale versions), and the commandId is
    // fresh too (the store dedupes by commandId).
    const attempt = async () => {
      const res = await emitAck(event, {
        ...payload,
        commandId: generateCommandId(),
        expectedRoomVersion: roomStateRef.current?.roomVersion,
      }).catch((err) => ({
        ok: false,
        code: 'ACK_TIMEOUT',
        error: err?.message || 'No response from server',
      }));
      return res;
    };
    let res = await attempt();
    // F2: a membership error means the command landed before the server
    // adopted this socket (refresh / reconnect race) — or the adoption is
    // still in flight. One retry after a short delay covers it; the first
    // attempt was never processed, so it cannot double-apply.
    if (!res?.ok && isMembershipError(res)) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      res = await attempt();
    }
    if (!res?.ok) {
      // F2: never show the raw lookup error ("Participant not found") — it
      // is a reconnect race, not a statement about the participant. The
      // message stays honest but actionable, and it clears as soon as the
      // next command succeeds (N-17).
      setRoomError(
        isMembershipError(res)
          ? 'Still reconnecting to the room — please try again in a moment.'
          : res?.error || `Command ${event} failed`,
      );
    } else {
      // N-17: clear any stale room error on success.
      setRoomError(null);
    }
    return res;
  }, [waitForAdoption]);

  // Wire OS lock-screen / MediaSession controls & visibility re-sync for background playback
  useEffect(() => {
    if (!roomState) return;
    const canControl =
      session?.role === 'host' || Boolean(roomState?.settings?.allowGuestControl);

    backgroundAudio.updateMetadata(currentTrack);
    backgroundAudio.setPlaying(roomState.playback?.playbackState === 'playing');
    backgroundAudio.setActionHandlers({
      onPlay: () => {
        if (canControl) {
          sendCommand('player:play', {
            positionMs: syncMetrics.reportedPositionMs || 0,
            scheduleLeadMs: 250,
          });
        } else {
          playerRef.current?.play().catch(() => {});
        }
      },
      onPause: () => {
        if (canControl) {
          sendCommand('player:pause', { positionMs: syncMetrics.reportedPositionMs || 0 });
        } else {
          playerRef.current?.pause().catch(() => {});
        }
      },
      onPrevious: () => {
        if (canControl) sendCommand('player:previous', {});
      },
      onNext: () => {
        if (canControl) sendCommand('player:next', {});
      },
      onSeekTo: (seekSec) => {
        if (canControl) sendCommand('player:seek', { positionMs: Math.round(seekSec * 1000) });
      },
    });
  }, [
    roomState,
    session?.role,
    currentTrack,
    sendCommand,
    syncMetrics.reportedPositionMs,
  ]);

  useEffect(() => {
    if (!currentTrack) return;
    // E-06/I-12: prefer the server's authoritative durationMs over the
    // seed-track's durationSec. During a track change the seed data may
    // still carry the previous track's length for a tick, causing the
    // lock-screen scrubber to flicker to the wrong duration before the
    // new value arrives.
    const durSec =
      Math.round((roomState?.playback?.durationMs || 0) / 1000) ||
      currentTrack.durationSec ||
      1;
    const posSec = Math.round((syncMetrics.reportedPositionMs || 0) / 1000);
    backgroundAudio.updatePosition(posSec, durSec);
  }, [currentTrack, roomState?.playback?.durationMs, syncMetrics.reportedPositionMs]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden && roomStateRef.current?.playback && currentTrack) {
        applyPlaybackToPlayer(roomStateRef.current.playback, currentTrack).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [applyPlaybackToPlayer, currentTrack]);

  const value = {
    roomState,
    session,
    myParticipant,
    partnerParticipant,
    partnerConnected,
    partnerLastSeenAtMs,
    currentTrack,
    connectionStatus,
    pendingApproval,
    roomError,
    playerError,
    audioUnlocked,
    syncMetrics,
    syncStatus,
    playerState,
    volume,
    muted,
    setVolume,
    toggleMute,
    getCurrentPositionMs,
    clearRoomError,
    reactions,
    unreadChatCount,
    setUnreadChatCount,
    partnerTyping,
    playerContainerRef,
    initPlayerForSource,
    reloadPlayer,
    createRoom,
    joinRoom,
    leaveRoom,
    unlockAudio,
    runClockSync,
    sendCommand,
    setPlayerError,
    setRoomError,
  };

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom() {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error('useRoom must be used inside RoomProvider');
  return ctx;
}
