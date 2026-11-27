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

const RoomContext = createContext(null);

const SESSION_STORAGE_KEY = 'duet_active_session';

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

  // Real sync telemetry
  const [syncMetrics, setSyncMetrics] = useState({
    rttMs: 0,
    clockOffsetMs: 0,
    driftMs: 0,
    reportedPositionMs: 0,
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

  roomStateRef.current = roomState;
  sessionRef.current = session;
  audioUnlockedRef.current = audioUnlocked;

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
        setPlayerError(null);
        await player.loadTrack(track, expectedMs);
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
    []
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

  // Setup Socket.IO listeners
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setConnectionStatus('connected');
      runClockSync();
      // Auto-reconnect if we have an active session
      const cur = sessionRef.current || loadSession();
      if (cur?.roomCode && cur?.sessionToken && !roomStateRef.current) {
        emitAck('room:reconnect', {
          roomCode: cur.roomCode,
          sessionToken: cur.sessionToken,
        })
          .then((res) => {
            if (res?.ok) {
              setSession({
                roomCode: res.roomCode,
                participantId: res.participantId,
                sessionToken: res.sessionToken,
                role: res.role,
              });
              setRoomState(res.state);
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
      setRoomState((prev) => (prev ? { ...prev, playback } : prev));
      const st = roomStateRef.current;
      const trk =
        st?.queue?.find((q) => q.queueItemId === st.currentQueueItemId)?.track ||
        st?.queue?.[0]?.track;
      if (trk) applyPlaybackToPlayer(playback, trk);
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
      setAudioUnlocked(false);
      runClockSync();
    };

    const onJoinDeclined = ({ error }) => {
      setPendingApproval(null);
      setRoomError(error || 'Host declined your join request');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:state', onRoomState);
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
  }, [applyPlaybackToPlayer, runClockSync]);

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

      if (st.playback.playbackState !== 'playing') {
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(actualMs),
          driftMs: Math.round(actualMs - expectedMs),
        }));
        return;
      }

      const evaluation = evaluateDriftCorrection({
        expectedMs,
        actualMs,
        lastCorrectionAtMs: lastCorrectionAtRef.current,
        consecutiveModerateCount: consecutiveDriftRef.current,
      });

      consecutiveDriftRef.current = evaluation.nextConsecutiveCount;

      if (evaluation.action === 'seek') {
        lastCorrectionAtRef.current = Date.now();
        await player.seek(evaluation.targetMs);
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(evaluation.targetMs),
          driftMs: evaluation.driftMs,
          correctionCount: prev.correctionCount + 1,
        }));
      } else {
        setSyncMetrics((prev) => ({
          ...prev,
          reportedPositionMs: Math.round(actualMs),
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

    const res = await emitAck('room:create', {
      name,
      source,
      initialTracks: INITIAL_TRACKS.slice(0, 3),
    });
    if (!res?.ok) {
      setRoomError(res?.error || 'Failed to create room');
      throw new Error(res?.error || 'Failed to create room');
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
    setAudioUnlocked(true);
    await runClockSync();
    return res;
  }, [runClockSync]);

  const joinRoom = useCallback(async ({ roomCode, name = 'Guest', source = 'youtube' }) => {
    setRoomError(null);
    setConnectionStatus('connecting');
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    const res = await emitAck('room:join', {
      roomCode: roomCode.trim().toUpperCase(),
      name,
      source,
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
