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
import { computeExpectedPositionMs, evaluateDriftCorrection } from '../utils/playbackSync';

export const RoomContext = createContext(null);

const SESSION_STORAGE_KEY = 'duet_active_session';
const VOLUME_STORAGE_KEY = 'duet_volume';
const DEFAULT_VOLUME = 0.85;

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

  const clockSyncRef = useRef(new ClockSync());
  const playerRef = useRef(null);
  const playerContainerRef = useRef(null);
  const lastCorrectionAtRef = useRef(0);
  const consecutiveDriftRef = useRef(0);
  const loadedTrackKeyRef = useRef(null);
  const roomStateRef = useRef(null);
  const sessionRef = useRef(null);
  const audioUnlockedRef = useRef(false);
  const scheduledPlayTimerRef = useRef(null);
  // N-02: real player duration (ms) cached from player.getDuration(); the
  // stored duration can be wrong (e.g. 210s fallback for pasted URLs).
  const realDurationRef = useRef(0);
  const lastReportedDurationRef = useRef(0);
  // N-04: pending room:create promise, resolved by the room:created event.
  const pendingCreateRef = useRef(null);
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

  const currentTrack = useMemo(() => {
    if (!roomState) return null;
    const found = roomState.queue.find((q) => q.queueItemId === roomState.currentQueueItemId);
    return found?.track || roomState.queue[0]?.track || null;
  }, [roomState]);

  // M5: human-readable sync status for the sync pill (UI subagent renders it).
  const syncStatus = useMemo(() => {
    if (!roomState) return 'waiting';
    const participants = roomState.participants || [];
    if (participants.some((p) => p.buffering)) return 'buffering';
    if (roomState.playback?.playbackState === 'paused') return 'paused';
    if (roomState.playback?.playbackState === 'playing') {
      const partner = participants.find((p) => session && p.id !== session.participantId) || null;
      // Partner has not joined / is not ready yet.
      if (participants.length < 2 || !partner || !partner.ready) return 'waiting';
      const me = participants.find((p) => session && p.id === session.participantId);
      if (me && !me.ready) return 'waiting';
      if (Math.abs(syncMetrics.driftMs) < 350) return 'in-sync';
      return 'syncing';
    }
    return 'waiting';
  }, [roomState, session, syncMetrics.driftMs]);

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
  // changed by >2s since the last report, so it never spams.
  const reportRealDuration = useCallback((realDurationMs, playback) => {
    if (!realDurationMs || realDurationMs <= 0 || !playback) return;
    realDurationRef.current = realDurationMs;
    const storedMs = playback.durationMs || 0;
    if (
      Math.abs(realDurationMs - storedMs) > 2000 &&
      Math.abs(realDurationMs - (lastReportedDurationRef.current || 0)) > 2000
    ) {
      lastReportedDurationRef.current = realDurationMs;
      emitAck('player:duration', {
        durationMs: Math.round(realDurationMs),
        trackVersion: playback.trackVersion,
      }).catch(() => {});
    }
  }, []);

  const maybeReportRealDuration = useCallback(
    async (playback) => {
      const player = playerRef.current;
      if (!player || !playback) return;
      try {
        const real = await player.getDuration();
        if (real > 0) reportRealDuration(real, playback);
      } catch {
        // Ignore — duration reporting is best-effort
      }
    },
    [reportRealDuration]
  );

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

  // Apply authoritative playback state to local player
  const applyPlaybackToPlayer = useCallback(
    async (playback, track) => {
      const player = playerRef.current;
      if (!player || !playback || !track) return;

      // Cancel any pending scheduled play so a stale timeout cannot
      // seek + play on an old state after a newer one arrives.
      if (scheduledPlayTimerRef.current) {
        clearTimeout(scheduledPlayTimerRef.current);
        scheduledPlayTimerRef.current = null;
      }

      const trackKey = `${track.id}:${playback.trackVersion}`;
      const estimatedNow = clockSyncRef.current.estimateServerNowMs();
      const expectedMs = computeExpectedPositionMs(playback, estimatedNow);

      if (loadedTrackKeyRef.current !== trackKey) {
        loadedTrackKeyRef.current = trackKey;
        realDurationRef.current = 0;
        lastReportedDurationRef.current = 0;
        setPlayerError(null);
        // B1: pass shouldPlay so YouTube uses loadVideoById (loads AND plays)
        // instead of cueVideoById (loads paused, losing the immediate play()).
        await player.loadTrack(track, expectedMs, playback.playbackState === 'playing');
        // N-02: correct the stored duration from the real player duration.
        await maybeReportRealDuration(playback);
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

      if (!audioUnlockedRef.current) return;

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
            await player.seek(playback.anchorPositionMs || 0);
            await player.play();
          }, delayMs);
        } else {
          const currentPos = await player.getPosition();
          if (Math.abs(currentPos - expectedMs) > 450) {
            await player.seek(expectedMs);
          }
          await player.play();
        }
      } else {
        await player.pause();
        const currentPos = await player.getPosition();
        if (Math.abs(currentPos - expectedMs) > 250) {
          await player.seek(expectedMs);
        }
      }
    },
    [maybeReportRealDuration]
  );

  // Initialize / switch player adapter when source or container changes
  const initPlayerForSource = useCallback(
    async (source, containerEl) => {
      const wantsYouTube = source === 'youtube' || source === 'audio';

      // Seamless switch between YouTube (video) and Audio Only without interrupting playback
      if (
        wantsYouTube &&
        playerRef.current instanceof YouTubePlayer &&
        containerEl &&
        playerRef.current.containerEl === containerEl
      ) {
        return;
      }

      if (playerRef.current) {
        await playerRef.current.destroy();
        playerRef.current = null;
        loadedTrackKeyRef.current = null;
      }

      const callbacks = {
        onReady: () => {
          if (sessionRef.current) {
            emitAck('player:ready', { ready: true }).catch(() => {});
          }
        },
        onStateChange: (state) => {
          if (
            state === 'paused' &&
            typeof document !== 'undefined' &&
            document.hidden &&
            roomStateRef.current?.playback?.playbackState === 'playing' &&
            audioUnlockedRef.current
          ) {
            // Keep audio playing when the mobile browser is minimized or backgrounded
            setTimeout(() => {
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
          const st = roomStateRef.current;
          if (sessionRef.current && st?.playback) {
            emitAck('player:status', {
              endedTrackVersion: st.playback.trackVersion,
            }).catch(() => {});
          }
        },
        onError: (err) => {
          setPlayerError(err);
        },
      };

      const adapter = wantsYouTube
        ? new YouTubePlayer(callbacks)
        : source === 'spotify'
          ? new SpotifyPlayer(callbacks)
          : new LocalAudioPlayer(callbacks);

      if (wantsYouTube && !containerEl) return;

      try {
        await adapter.initialize(containerEl);
        playerRef.current = adapter;
        // M3: apply the stored volume/muted state to the new player.
        try {
          await adapter.setVolume?.(volumeRef.current);
          if (mutedRef.current) await adapter.setMuted?.(true);
        } catch {
          // Ignore — volume can be re-applied later via setVolume/toggleMute
        }
        setPlayerError(null);

        const st = roomStateRef.current;
        const trk =
          st?.queue?.find((q) => q.queueItemId === st.currentQueueItemId)?.track ||
          st?.queue?.[0]?.track;
        if (st?.playback && trk) {
          await applyPlaybackToPlayer(st.playback, trk);
        }
      } catch (err) {
        setPlayerError({ code: 'INIT_FAILED', message: err.message });
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
      setRoomState(res.state);
      setAudioUnlocked(true);
      await runClockSync();
      return res;
    },
    [runClockSync]
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
              setRoomState(res.state);
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
      setSyncMetrics((prev) => ({ ...prev, reconnectCount: prev.reconnectCount + 1 }));
    };

    const onRoomState = (nextState) => {
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
      setRoomState((prev) => (prev ? { ...prev, playback } : prev));
    };

    const onQueueUpdated = ({ queue, currentQueueItemId }) => {
      setRoomState((prev) => (prev ? { ...prev, queue, currentQueueItemId } : prev));
    };

    const onChatMessage = (msg) => {
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
        setPartnerTyping(true);
        if (partnerTypingTimerRef.current) clearTimeout(partnerTypingTimerRef.current);
        partnerTypingTimerRef.current = setTimeout(() => setPartnerTyping(false), 2500);
      }
    };

    const onReactionBurst = (burst) => {
      setReactions((prev) => [...prev.slice(-12), burst]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== burst.id));
      }, 2600);
    };

    const onRoomClosed = ({ reason }) => {
      setRoomError(reason || 'Room closed');
      setPendingApproval(null);
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
      setRoomState(res.state);
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

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
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

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
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
    };
  }, [applyPlaybackToPlayer, runClockSync, adoptCreatedRoom]);

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

      // N-02/B2: read the real duration every tick; report it to the server
      // when it differs from the stored one, and never seek the player back
      // when it is within 1500ms of its real end (let onEnded fire).
      let realDurationMs = 0;
      try {
        realDurationMs = await player.getDuration();
      } catch {
        realDurationMs = 0;
      }
      if (realDurationMs > 0) reportRealDuration(realDurationMs, st.playback);

      if (st.playback.playbackState !== 'playing') {
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(actualMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: Math.round(actualMs - expectedMs),
        }));
        return;
      }

      // B1: do NOT seek when the player is still on the previous track.
      // After Next, loadVideoById takes a moment to swap the video; until
      // it does, the player's position/duration belong to the OLD video and
      // any seek here would pin the old video in place (and stop the new
      // one from ever loading). Compare the actually-loaded media ID with
      // the current track's ID and skip the correction until they match.
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
      const expectedId = curTrack
        ? mySource === 'spotify'
          ? curTrack.spotifyUri || null
          : mySource === 'local'
            ? curTrack.id || null
            : curTrack.youtubeId || null
        : null;
      if (loadedId && expectedId && loadedId !== expectedId) {
        // Player is still on the previous track — report the position but
        // do not seek or count this as drift.
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(actualMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: 0,
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
        lastCorrectionAtRef.current = Date.now();
        await player.seek(evaluation.targetMs);
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(evaluation.targetMs),
          expectedPositionMs: Math.round(expectedMs),
          driftMs: evaluation.driftMs,
          correctionCount: prev.correctionCount + 1,
        }));
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
      setSyncMetrics((prev) => ({ ...prev, expectedPositionMs: Math.round(expectedMs) }));
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
        emitAck('sync:request', {}).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [runClockSync]);

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
    setRoomState(res.state);
    setAudioUnlocked(false); // Mobile guest requires gesture unlock
    await runClockSync();
    return res;
  }, [runClockSync]);

  const leaveRoom = useCallback(async () => {
    try {
      await emitAck('room:leave', {});
    } catch {
      // Ignore
    }
    if (playerRef.current) {
      await playerRef.current.destroy();
      playerRef.current = null;
      loadedTrackKeyRef.current = null;
    }
    backgroundAudio.destroy();
    clearSession();
    setSession(null);
    setRoomState(null);
    setAudioUnlocked(false);
    setPlayerError(null);
  }, []);

  const unlockAudio = useCallback(async () => {
    setAudioUnlocked(true);
    audioUnlockedRef.current = true;
    await backgroundAudio.unlock();
    const player = playerRef.current;
    if (player && typeof player.initialize === 'function' && myParticipant?.source === 'local') {
      await player.initialize();
    }
    await emitAck('player:ready', { ready: true }).catch(() => {});
    const st = roomStateRef.current;
    if (st?.playback && currentTrack) {
      await applyPlaybackToPlayer(st.playback, currentTrack);
    }
  }, [applyPlaybackToPlayer, currentTrack, myParticipant?.source]);

  const sendCommand = useCallback(async (event, payload = {}) => {
    const res = await emitAck(event, {
      ...payload,
      commandId: generateCommandId(),
      expectedRoomVersion: roomStateRef.current?.roomVersion,
    });
    if (!res?.ok) {
      setRoomError(res?.error || `Command ${event} failed`);
    } else {
      // N-17: clear any stale room error on success.
      setRoomError(null);
    }
    return res;
  }, []);

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
    const durSec =
      currentTrack.durationSec || Math.round((roomState?.playback?.durationMs || 0) / 1000) || 1;
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
    currentTrack,
    connectionStatus,
    pendingApproval,
    roomError,
    playerError,
    audioUnlocked,
    syncMetrics,
    syncStatus,
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
