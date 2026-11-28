import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AudioLines,
  Bell,
  ChevronDown,
  Check,
  Clock,
  Copy,
  Disc3,
  Heart,
  ListMusic,
  Lock,
  MessageCircle,
  Palette,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  SkipBack,
  SkipForward,
  Smartphone,
  Loader2,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { INITIAL_TRACKS, SEARCH_CATALOG, formatTime } from '../data/mockTracks';
import { resolveNowPlayingDurationSec } from '../utils/playbackSync';
import { useRoom } from '../context/RoomContext';
import { searchMusicBackend } from '../services/apiClient';
import { resolveYouTubeTrack, searchRealSongs } from '../utils/artworkApi';
import { getStoredSpotifyAuth } from '../utils/spotifyAuth';
import AudioVisualizerCanvas from './AudioVisualizerCanvas';
import SpotifyConnectModal from './SpotifyConnectModal';
import RoomLobby from './RoomLobby';
import ThemeBackground, { THEME_CONFIG } from './ThemeBackground';
import './RoomView.css';

const THEME_STYLES = THEME_CONFIG;

const ROOM_MOBILE_MEDIA = '(max-width: 767px), (max-width: 1023px) and (max-height: 500px) and (pointer: coarse)';

const ROOM_NAVIGATION = [
  { id: 'player', label: 'Listen', icon: AudioLines },
  { id: 'queue', label: 'Queue', icon: ListMusic },
  { id: 'search', label: 'Add', icon: Plus },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'lobby', label: 'Lobby', icon: Users },
];

const REACTION_EMOJIS = ['❤️', '🔥', '🎵', '😊', '✨', '😭'];

// R2(b): queue:add failures where the socket is simply not adopted (yet) —
// the server rejected the command before room:reconnect re-established
// membership. These are transient, never a statement about the participant,
// so the add is retried once and the raw lookup error is never shown.
const MEMBERSHIP_ERROR_CODES = ['NOT_IN_ROOM', 'PARTICIPANT_NOT_FOUND', 'UNAUTHORIZED'];

export default function RoomView({ isDemo = false, onLeave, demoTrack = null, demoState = null, onDemoStateChange }) {
  const {
    roomState,
    session,
    myParticipant,
    partnerParticipant,
    // R3: derived presence from RoomContext (server flag + recent partner
    // traffic). Falls back to the raw server flag for hand-built contexts
    // that do not provide it.
    partnerConnected: ctxPartnerConnected,
    currentTrack: realTrack,
    connectionStatus,
    roomError,
    playerError,
    audioUnlocked: realAudioUnlocked,
    syncMetrics,
    reactions,
    unreadChatCount,
    setUnreadChatCount,
    partnerTyping,
    initPlayerForSource,
    unlockAudio,
    runClockSync,
    sendCommand,
    leaveRoom,
    setPlayerError,
    setRoomError,
    // Optional APIs exposed by the client-core round (volume/syncStatus/
    // getCurrentPositionMs/clearRoomError). They may be undefined until that
    // round lands — every use below falls back gracefully.
    volume: ctxVolume,
    muted: ctxMuted,
    setVolume: ctxSetVolume,
    toggleMute: ctxToggleMute,
    syncStatus: ctxSyncStatus,
    // R4: this tab's local player state — the ground truth for the Play/Pause
    // button. May be undefined with an older context value; every use below
    // falls back to the server playback state.
    playerState: ctxPlayerState,
    getCurrentPositionMs,
    clearRoomError,
    // Round 4: full in-app player reset (what a page reload does). May be
    // undefined with an older context value — the "Reload player" button
    // only renders when it exists.
    reloadPlayer: ctxReloadPlayer,
  } = useRoom();

  // ——— Demo Mode Fallback State (only used when isDemo === true) ———
  // M9: demo state is lifted to App.jsx (demoState) so leaving/re-entering
  // the demo preserves pause state, track, queue and chat while the page is
  // open. M6: a trending card passes demoTrack, which becomes the first track.
  const [demoRole, setDemoRole] = useState(demoState?.role || 'host');
  const [demoSource, setDemoSource] = useState(demoState?.source || 'local');
  const [demoPartnerSource, setDemoPartnerSource] = useState(demoState?.partnerSource || 'youtube');
  const [demoUnlocked, setDemoUnlocked] = useState(demoState?.unlocked ?? true);
  const [demoQueue, setDemoQueue] = useState(
    demoState?.queue ||
      (demoTrack
        ? [demoTrack, ...INITIAL_TRACKS.filter((t) => t.id !== demoTrack.id)]
        : INITIAL_TRACKS)
  );
  const [demoIdx, setDemoIdx] = useState(demoState?.idx || 0);
  const [demoPlaying, setDemoPlaying] = useState(demoState?.playing ?? true);
  const [demoTime, setDemoTime] = useState(demoState?.time ?? (demoTrack ? 0 : 102));
  const [demoTheme, setDemoTheme] = useState(demoState?.theme || 'midnight');
  const [demoStartMs] = useState(() => demoState?.startedAtMs || Date.now());
  const [demoChat, setDemoChat] = useState(demoState?.chat || []);
  const [demoReactions, setDemoReactions] = useState(demoState?.reactions || []);

  // Persist demo state back to App.jsx whenever it changes (M9).
  useEffect(() => {
    if (!isDemo || typeof onDemoStateChange !== 'function') return;
    onDemoStateChange({
      role: demoRole,
      source: demoSource,
      partnerSource: demoPartnerSource,
      unlocked: demoUnlocked,
      queue: demoQueue,
      idx: demoIdx,
      playing: demoPlaying,
      time: demoTime,
      theme: demoTheme,
      startedAtMs: demoStartMs,
      chat: demoChat,
      reactions: demoReactions,
    });
  }, [isDemo, demoRole, demoSource, demoPartnerSource, demoUnlocked, demoQueue, demoIdx, demoPlaying, demoTime, demoTheme, demoStartMs, demoChat, demoReactions, onDemoStateChange]);

  useEffect(() => {
    if (!isDemo || !demoPlaying) return;
    const t = setInterval(() => {
      setDemoTime((p) => {
        const dur = demoQueue[demoIdx]?.durationSec || 200;
        if (p + 1 >= dur) {
          setDemoIdx((i) => (i + 1) % demoQueue.length);
          return 0;
        }
        return p + 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [isDemo, demoPlaying, demoIdx, demoQueue]);

  // ——— Shared UI State ———
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  // Round 4: disables the "Reload player" button while a reload is running.
  const [reloadingPlayer, setReloadingPlayer] = useState(false);
  const [activeTab, setActiveTab] = useState('queue');
  const [activityInView, setActivityInView] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.matchMedia?.(ROOM_MOBILE_MEDIA).matches ?? false);
  const chatInView = activeTab === 'chat' && (!isMobileLayout || activityInView);
  const [searchQuery, setSearchQuery] = useState('');
  const [dedication, setDedication] = useState('');
  const [liveResults, setLiveResults] = useState([]);
  const [youtubeApiConfigured, setYoutubeApiConfigured] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [chatText, setChatText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [respondingToJoin, setRespondingToJoin] = useState(false);
  const [chatToast, setChatToast] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [showMetrics, setShowMetrics] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showSessionSummary, setShowSessionSummary] = useState(false);
  const [showSpotifyModal, setShowSpotifyModal] = useState(false);
  const chatTypingTimerRef = useRef(null);
  const lastSeenChatIdRef = useRef(null);
  const knownParticipantIdsRef = useRef(null);
  const knownPendingJoinIdsRef = useRef(new Set());
  const toastTimerRef = useRef(null);
  const actionToastTimerRef = useRef(null);
  const armTimerRef = useRef(null);
  const seekTimerRef = useRef(null);
  const scrubSecRef = useRef(null);
  const rightPanelRef = useRef(null);
  const activityHeadingRef = useRef(null);
  const playerHeadingRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const followChatRef = useRef(true);
  const themePickerRef = useRef(null);
  const [toast, setToast] = useState(null);
  // N-06: local scrub position while dragging, so the slider follows the
  // drag immediately while the server seek is debounced (see handleSeek).
  const [scrubSec, setScrubSec] = useState(null);
  const [playLoading, setPlayLoading] = useState(false);
  const [armedAction, setArmedAction] = useState(null); // N-24: 'end' | 'host'
  // M3: volume falls back to local state until the context exposes it.
  const [localVolume, setLocalVolume] = useState(0.8);
  const [localMuted, setLocalMuted] = useState(false);
  const volume = ctxVolume ?? localVolume;
  const muted = ctxMuted ?? localMuted;

  const showToast = (msg) => {
    setToast(msg);
    if (actionToastTimerRef.current) clearTimeout(actionToastTimerRef.current);
    actionToastTimerRef.current = setTimeout(() => setToast(null), 2500);
  };
  const applyVolume = (v) => {
    if (typeof ctxSetVolume === 'function') ctxSetVolume(v);
    else setLocalVolume(v);
    if (v > 0) setLocalMuted(false);
  };
  const applyToggleMute = () => {
    if (typeof ctxToggleMute === 'function') ctxToggleMute();
    else setLocalMuted((m) => !m);
  };
  // N-24: tap once to arm, tap again to confirm a destructive action.
  const armOrRun = (action, run) => {
    if (armedAction === action) {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      setArmedAction(null);
      run();
      return;
    }
    setArmedAction(action);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => setArmedAction(null), 4000);
  };

  const ytContainerRef = useRef(null);

  // Derived active values
  const roomCode = isDemo ? 'DEMO-K7' : roomState?.roomCode || '------';
  const isHost = isDemo ? demoRole === 'host' : session?.role === 'host';
  const canControl = isHost || (!isDemo && Boolean(roomState?.settings?.allowGuestControl));
  const mySource = isDemo ? demoSource : myParticipant?.source || 'youtube';
  const audioUnlocked = isDemo ? demoUnlocked : realAudioUnlocked;
  const currentTrack = isDemo ? demoQueue[demoIdx] || demoQueue[0] : realTrack;
  const queue = isDemo
    ? demoQueue.map((t, i) => ({ queueItemId: `demo-${i}`, track: t, addedByName: 'Demo' }))
    : roomState?.queue || [];
  const currentQueueItemId = isDemo
    ? `demo-${demoIdx}`
    : roomState?.currentQueueItemId;

  // R4: the Play/Pause icon follows the LOCAL player, not the server's
  // playback flag, which lagged in the live test (guest showed "Paused"
  // while playing). 'buffering' counts as playing — the video is on its way
  // and Pause is the honest action. With no live local state yet
  // (idle / ready / context without playerState), fall back to the server.
  const serverPlaying = !isDemo && roomState?.playback?.playbackState === 'playing';
  const isPlaying = isDemo
    ? demoPlaying
    : ctxPlayerState === 'playing' || ctxPlayerState === 'buffering'
      ? true
      : ctxPlayerState === 'paused' || ctxPlayerState === 'ended' || ctxPlayerState === 'error'
        ? false
        : serverPlaying;
  // R5 + flicker: prefer the server playback duration (set atomically with
  // the track on every change) over the track's stored durationSec — the
  // UI's currentTrack still points at the PREVIOUS track until queue:updated
  // lands, so durationSec flashed the old track's length after each switch.
  const durationSec = resolveNowPlayingDurationSec({
    trackDurationSec: currentTrack?.durationSec,
    playbackDurationMs: roomState?.playback?.durationMs,
  });
  const currentSec = isDemo
    ? demoTime
    : Math.round((syncMetrics.reportedPositionMs || 0) / 1000);
  // N-06: while scrubbing, show the dragged position instead of the
  // server-reported one so the slider does not snap back mid-drag.
  const displaySec = scrubSec ?? currentSec;
  // M4: the room theme comes from roomState.settings.theme (server truth),
  // so it survives a refresh instead of reverting to the dark default.
  const theme = isDemo ? demoTheme : roomState?.settings?.theme || 'midnight';
  // R3: presence shown for the partner. Prefer the derived value from the
  // context (live socket state + recent partner traffic); the raw server
  // flag is only a fallback for contexts that do not provide it.
  const partnerConnected = ctxPartnerConnected ?? partnerParticipant?.connected ?? false;

  // Initialize real player adapter when source or room changes
  useEffect(() => {
    if (isDemo || !roomState) return;
    initPlayerForSource(mySource, ytContainerRef.current);
  }, [isDemo, mySource, Boolean(roomState), initPlayerForSource]);

  // Clear unread chat count when opening chat tab
  useEffect(() => {
    if (chatInView && unreadChatCount > 0) setUnreadChatCount(0);
  }, [chatInView, unreadChatCount, setUnreadChatCount]);

  useEffect(() => {
    if (chatInView) setChatToast((toast) => toast?.type === 'chat' ? null : toast);
  }, [chatInView]);

  // Pop notification toast & record notification when partner sends a message
  useEffect(() => {
    if (isDemo || !roomState?.chat?.length) return;
    const latest = roomState.chat[roomState.chat.length - 1];
    if (!latest) return;

    if (lastSeenChatIdRef.current === null) {
      lastSeenChatIdRef.current = latest.id;
      return;
    }

    if (latest.id !== lastSeenChatIdRef.current) {
      lastSeenChatIdRef.current = latest.id;
      if (latest.senderId !== session?.participantId) {
        setNotifications((prev) => [{ type: 'chat', ...latest }, ...prev].slice(0, 15));
        if (!chatInView) {
          setChatToast({ type: 'chat', ...latest });
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(() => setChatToast(null), 5000);
        }
      }
    }
  }, [isDemo, roomState?.chat, session?.participantId, chatInView]);

  // Notify when a partner joins or requests to join
  useEffect(() => {
    if (isDemo || !roomState) return;

    // 1. Pending join requests (when requireApproval is enabled)
    const pending = roomState.pendingJoins || [];
    for (const req of pending) {
      if (!knownPendingJoinIdsRef.current.has(req.id)) {
        knownPendingJoinIdsRef.current.add(req.id);
        setChatToast({ type: 'join_request', ...req });
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setChatToast(null), 15000);
      }
    }

    // 2. Partner joined directly
    const currentIds = new Set((roomState.participants || []).map((p) => p.id));
    if (knownParticipantIdsRef.current === null) {
      knownParticipantIdsRef.current = currentIds;
      return;
    }
    for (const p of roomState.participants || []) {
      if (!knownParticipantIdsRef.current.has(p.id) && p.id !== session?.participantId) {
        const note = {
          id: `join_${p.id}_${Date.now()}`,
          type: 'joined',
          senderName: p.name,
          text: `${p.name} joined the room`,
        };
        setNotifications((prev) => [note, ...prev].slice(0, 15));
        setChatToast(note);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setChatToast(null), 5000);
      }
    }
    knownParticipantIdsRef.current = currentIds;
  }, [isDemo, roomState, session?.participantId]);

  // Close notification popover on outside click
  useEffect(() => {
    if (!showNotifications) return;
    const onDown = (e) => {
      if (!e.target.closest('[data-notifications-menu]')) setShowNotifications(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showNotifications]);

  useEffect(() => {
    const media = window.matchMedia?.(ROOM_MOBILE_MEDIA);
    if (!media) return;
    const updateLayout = (event) => setIsMobileLayout(event.matches);
    media.addEventListener?.('change', updateLayout);
    return () => media.removeEventListener?.('change', updateLayout);
  }, []);

  useEffect(() => {
    if (!rightPanelRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setActivityInView(entry.isIntersecting),
      { rootMargin: '0px 0px -60% 0px' }
    );
    observer.observe(rightPanelRef.current);
    return () => observer.disconnect();
  }, []);

  const chatMessages = isDemo ? demoChat : roomState?.chat;
  const latestChatId = chatMessages?.at(-1)?.id;
  useEffect(() => {
    const messages = chatMessagesRef.current;
    if (chatInView && messages && followChatRef.current) messages.scrollTop = messages.scrollHeight;
  }, [chatInView, latestChatId, partnerTyping]);

  const navigateRoom = (destination) => {
    if (destination !== 'player') setActiveTab(destination);
    if (isMobileLayout) {
      setActivityInView(destination !== 'player');
      setShowSettings(false);
      setShowMetrics(false);
      setShowNotifications(false);
    }
    if (destination === 'chat') followChatRef.current = true;
    if (destination === 'lobby') setChatToast((toast) => toast?.type === 'join_request' ? null : toast);
    requestAnimationFrame(() => {
      const heading = destination === 'player' ? playerHeadingRef.current : activityHeadingRef.current;
      if (isMobileLayout) heading?.focus({ preventScroll: true });
      if (destination === 'player') {
        window.scrollTo({ top: 0, behavior: 'instant' });
      } else {
        rightPanelRef.current?.scrollIntoView?.({ block: isMobileLayout ? 'start' : 'nearest', behavior: 'instant' });
      }
    });
  };

  const openChatFromNotification = () => {
    navigateRoom('chat');
    setUnreadChatCount(0);
    setChatToast(null);
    setShowNotifications(false);
  };

  // Debounced search
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setLiveResults([]);
      setIsSearching(false);
      setSearchError('');
      return;
    }

    const controller = new AbortController();
    setIsSearching(true);
    setSearchError('');

    const timer = setTimeout(async () => {
      try {
        if (isDemo) {
          const items = await searchRealSongs(q, 8);
          setLiveResults(items);
        } else {
          const data = await searchMusicBackend(q, controller.signal);
          setLiveResults(data.items || []);
          setYoutubeApiConfigured(data.youtubeConfigured !== false);
          if (data.error) setSearchError(data.error);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          try {
            const fallback = await searchRealSongs(q, 8);
            setLiveResults(fallback);
          } catch {
            setSearchError('Search unavailable right now.');
          }
        }
      } finally {
        setIsSearching(false);
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, isDemo]);

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return SEARCH_CATALOG;
    if (liveResults.length > 0) return liveResults;
    return SEARCH_CATALOG.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
    );
  }, [searchQuery, liveResults]);

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(roomCode).catch(() => {});
    setCopied(true);
    showToast('Room code copied');
    setTimeout(() => setCopied(false), 1800);
  };

  const handleCopyInviteLink = () => {
    const link = `${window.location.origin}/room/${roomCode}`;
    navigator.clipboard?.writeText(link).catch(() => {});
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1800);
  };

  const handleLeaveClick = async () => {
    setShowSessionSummary(true);
  };

  const confirmLeave = async () => {
    setShowSessionSummary(false);
    if (!isDemo) {
      await leaveRoom();
    }
    onLeave();
  };

  const handleSourceSwitch = async (nextSource) => {
    if (isDemo) {
      setDemoSource(nextSource);
      return;
    }
    if (nextSource === 'spotify' && !getStoredSpotifyAuth()?.accessToken) {
      setShowSpotifyModal(true);
      return;
    }
    await sendCommand('participant:update', { source: nextSource });
  };

  const handlePlayPause = async () => {
    if (!canControl) return;
    if (isDemo) {
      setDemoPlaying((p) => !p);
      return;
    }
    // N-25: anchor on the live player position, not the ~1s-stale reported one.
    setPlayLoading(true);
    try {
      let posMs = syncMetrics.expectedPositionMs ?? currentSec * 1000;
      if (typeof getCurrentPositionMs === 'function') {
        try {
          const live = await getCurrentPositionMs();
          if (typeof live === 'number') posMs = live;
        } catch {
          // Fall back to the expected position above.
        }
      }
      if (isPlaying) {
        await Promise.race([
          sendCommand('player:pause', { positionMs: Math.round(posMs) }),
          // R1/R4: the command ack can take up to 60s on a flaky socket —
          // never let the button spin on "Loading…" that long. The room
          // state update (or the effect below, when playback actually
          // starts) clears the spinner; the raced command still runs and
          // still reports its own error.
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } else {
        await Promise.race([
          sendCommand('player:play', { positionMs: Math.round(posMs), scheduleLeadMs: 250 }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    } finally {
      setPlayLoading(false);
    }
  };

  // R4: the loading state must clear as soon as playback actually starts —
  // not when the (possibly 60s) command ack eventually returns.
  useEffect(() => {
    if (isPlaying) setPlayLoading(false);
  }, [isPlaying]);

  // m2: Resync with a brief confirmation.
  const handleResync = async () => {
    if (isDemo) {
      setDemoTime(currentSec);
    } else {
      await runClockSync();
    }
    showToast('Resynced — clocks re-measured');
  };

  // m2: Remove from queue with a brief confirmation.
  const handleRemoveTrack = async (queueItemId) => {
    await sendCommand('queue:remove', { queueItemId });
    showToast('Removed from queue');
  };

  // N-06: scrubber drag is debounced — the slider follows the drag
  // immediately (scrubSec), but player:seek is only sent 250ms after the
  // last movement (or immediately on release), so a drag does not spam
  // the server with a seek per input event.
  const flushSeek = useCallback(async () => {
    if (seekTimerRef.current) {
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
    const sec = scrubSecRef.current;
    if (sec == null) return;
    scrubSecRef.current = null;
    setScrubSec(null);
    await sendCommand('player:seek', { positionMs: sec * 1000 });
  }, [sendCommand]);

  const handleSeek = async (e) => {
    if (!canControl) return;
    const sec = Number(e.target.value);
    if (isDemo) {
      setDemoTime(sec);
      return;
    }
    // Show the dragged position at once; send the seek once the user
    // stops moving the scrubber for 250ms.
    scrubSecRef.current = sec;
    setScrubSec(sec);
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      seekTimerRef.current = null;
      flushSeek();
    }, 250);
  };

  // Clear any pending debounced seek when the room view unmounts.
  useEffect(
    () => () => {
      if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    },
    []
  );

  const handleStep = async (dir) => {
    if (!canControl) return;
    if (isDemo) {
      setDemoIdx((i) => (i + dir + demoQueue.length) % demoQueue.length);
      setDemoTime(0);
      return;
    }
    // E-25: immediately snap progress display to 00:00 when clicking Next/Prev
    setScrubSec(0);
    scrubSecRef.current = 0;
    await sendCommand(dir > 0 ? 'player:next' : 'player:previous', {});
  };

  // Clear any optimistic step/scrub once the new track or version takes over
  useEffect(() => {
    setScrubSec(null);
    scrubSecRef.current = null;
  }, [currentTrack?.id, roomState?.playback?.trackVersion]);

  // Paste-a-YouTube-link: extract the video ID from a pasted URL and add
  // it directly (fetching the title from YouTube's public oEmbed endpoint).
  // This does not depend on the backend's /api/youtube/resolve endpoint,
  // so pasting a link works even before the PR #4 backend is deployed.
  const extractYouTubeId = (input) => {
    const trimmed = String(input || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      const host = url.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') {
        const id = url.pathname.replace(/^\//, '').slice(0, 11);
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        const v = url.searchParams.get('v');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
        const parts = url.pathname.split('/').filter(Boolean);
        const idx = parts.findIndex((p) => p === 'shorts' || p === 'embed' || p === 'live');
        if (idx !== -1 && parts[idx + 1] && /^[A-Za-z0-9_-]{11}$/.test(parts[idx + 1])) {
          return parts[idx + 1];
        }
      }
    } catch {
      // Not a URL
    }
    return null;
  };

  const handleAddYouTubeLink = async (url) => {
    const videoId = extractYouTubeId(url);
    if (!videoId) return false;
    setSearchError('');
    // Get the title/author from YouTube's public oEmbed (no API key).
    let title = 'YouTube Track';
    let artist = 'YouTube';
    let coverImage = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${videoId}`
        )}&format=json`
      );
      if (res.ok) {
        const data = await res.json();
        title = data.title || title;
        artist = (data.author_name || artist).replace(/\s*-\s*Topic$/i, '');
        coverImage = data.thumbnail_url || coverImage;
      }
    } catch {
      // Keep the fallback title — the video ID is what matters.
    }
    await handleAddTrack({
      id: `yt-${videoId}`,
      title,
      artist,
      album: 'YouTube',
      // Duration is unknown from oEmbed. The production backend (pre-PR #4)
      // requires durationSec to be a number, so send 210 as a placeholder;
      // the player reports the real duration via player:duration as soon as
      // the track starts playing, which corrects it (N-02). The PR #4
      // backend accepts null here, but a number works on both.
      durationSec: 210,
      coverImage,
      youtubeId: videoId,
      sourceAttribution: 'YouTube (oEmbed)',
      attributionUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
    return true;
  };

  const handleAddTrack = async (track) => {
    const trackPayload = {
      ...track,
      dedication: dedication.trim() || undefined,
    };
    if (isDemo) {
      // Demo playback is simulated, so no YouTube resolution is needed.
      setDemoQueue((prev) => [...prev, trackPayload]);
      setDedication('');
      navigateRoom('queue');
      return;
    }
    // N-01: never add a track with no verified YouTube ID. Resolve it first;
    // if no playable version exists, say so and do NOT add the broken track.
    if (!trackPayload.youtubeId) {
      setSearchError('');
      const resolved = await resolveYouTubeTrack(trackPayload.title, trackPayload.artist);
      if (resolved?.item?.youtubeId) {
        trackPayload.youtubeId = resolved.item.youtubeId;
        if (resolved.item.durationSec) trackPayload.durationSec = resolved.item.durationSec;
      } else {
        setSearchError('No playable YouTube version found — paste a YouTube link instead');
        return;
      }
    }
    // R2(a/b): a guest add can fail for two very different reasons, and the
    // user must never see the misleading 'Participant not found' text.
    // - GUEST_QUEUE_DISABLED: the host turned guest adds off — say so honestly.
    // - Membership codes: the socket is not adopted (yet). socket.io flushes
    //   buffered emits BEFORE the connect handler re-adopts the socket via
    //   room:reconnect, so an add sent during a reconnect can land first.
    //   Retry once after a pause; if it still fails, show a neutral retry
    //   message. (sendCommand already put the raw error in the banner, so
    //   clear it whenever we show our own message instead.)
    let res = await sendCommand('queue:add', { track: trackPayload });
    if (res?.ok) {
      setDedication('');
      navigateRoom('queue');
      showToast('Added to queue');
      return;
    }
    if (res?.code === 'GUEST_QUEUE_DISABLED') {
      setRoomError(null);
      setSearchError('Guest queue additions are disabled by the host');
      return;
    }
    if (res && MEMBERSHIP_ERROR_CODES.includes(res.code)) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      res = await sendCommand('queue:add', { track: trackPayload });
      if (res?.ok) {
        setDedication('');
        navigateRoom('queue');
        showToast('Added to queue');
        return;
      }
      if (res?.code === 'GUEST_QUEUE_DISABLED') {
        setRoomError(null);
        setSearchError('Guest queue additions are disabled by the host');
        return;
      }
      if (res && MEMBERSHIP_ERROR_CODES.includes(res.code)) {
        setRoomError(null);
        setSearchError('Still reconnecting to the room — please try adding again in a moment.');
      }
      // Any other failure keeps the banner error sendCommand already set.
    }
  };

  const handleChatInputChange = (e) => {
    setChatText(e.target.value);
    // Send typing indicator (throttled to once per 2s)
    if (!isDemo && !chatTypingTimerRef.current) {
      sendCommand('chat:typing', {}).catch(() => {});
      chatTypingTimerRef.current = setTimeout(() => {
        chatTypingTimerRef.current = null;
      }, 2000);
    }
  };

  const handleSendChat = async (e) => {
    e.preventDefault();
    const txt = chatText.trim();
    if (!txt) return;
    followChatRef.current = true;
    if (isDemo) {
      // M9: demo chat is local-only, like a real room's chat.
      setDemoChat((prev) => [
        ...prev,
        {
          id: `demo-msg-${Date.now()}`,
          senderId: 'demo-self',
          senderName: isHost ? 'Host' : 'Guest',
          text: txt,
          createdAtMs: Date.now(),
        },
      ]);
      setChatText('');
      return;
    }
    // F2: only clear the text once the message actually sent. Before this
    // the text was cleared first, so a message that failed in the refresh /
    // reconnect race was lost forever and the guest's chat stayed empty.
    const res = await sendCommand('chat:send', { text: txt });
    if (res?.ok) setChatText('');
  };

  const handleClearQueue = async () => {
    if (isDemo) {
      setDemoQueue([]);
      setDemoIdx(0);
      return;
    }
    await sendCommand('queue:clear', {});
  };

  // Session duration — m7: real elapsed time (demo uses its actual start,
  // real rooms use the server-created timestamp). Never hardcoded.
  const sessionStartMs = isDemo ? demoStartMs : roomState?.createdAtMs;
  const sessionDurationSec = sessionStartMs ? Math.max(0, Math.floor((Date.now() - sessionStartMs) / 1000)) : 0;
  const sessionDurationStr = `${Math.floor(sessionDurationSec / 60)}m ${sessionDurationSec % 60}s`;
  const tracksPlayedCount = isDemo ? demoIdx + 1 : roomState?.stats?.tracksPlayed || 0;

  const handleSendReaction = async (emoji) => {
    if (isDemo) {
      // M9: demo reactions are local-only.
      const reaction = {
        id: `demo-reaction-${Date.now()}`,
        emoji,
        senderName: isHost ? 'Host' : 'Guest',
      };
      setDemoReactions((prev) => [...prev, reaction].slice(-5));
      setTimeout(() => {
        setDemoReactions((prev) => prev.filter((r) => r.id !== reaction.id));
      }, 4000);
      return;
    }
    await sendCommand('reaction:send', { emoji });
  };

  const themeConfig = THEME_STYLES[theme] || THEME_STYLES.midnight;
  const changeTheme = (nextTheme) => {
    if (isDemo) setDemoTheme(nextTheme);
    else sendCommand('room:settings', { theme: nextTheme });
  };
  const syncLabel = isDemo
    ? 'Simulated'
    : ctxSyncStatus
      ? { waiting: 'Waiting for partner', buffering: 'Buffering', 'in-sync': 'In sync', paused: 'Paused', syncing: 'Syncing', error: 'Playback error' }[ctxSyncStatus] || ctxSyncStatus
      : partnerParticipant ? roomState?.lifecycleState || connectionStatus : 'Waiting for partner';
  const activityTitle = { queue: 'Queue', search: 'Add a song', chat: 'Chat', lobby: 'Lobby' }[activeTab];
  const pendingJoins = roomState?.pendingJoins || [];
  const badgeCount = { chat: unreadChatCount, lobby: pendingJoins.length };
  const switchDemoPartnerSource = () => setDemoPartnerSource((source) => source === 'youtube' ? 'audio' : 'youtube');

  const respondToJoin = async (requestId, approve) => {
    if (respondingToJoin) return;
    setRespondingToJoin(true);
    try {
      const response = await sendCommand('room:join-respond', { requestId, approve });
      if (response?.ok) setChatToast((toast) => toast?.id === requestId ? null : toast);
    } finally {
      setRespondingToJoin(false);
    }
  };

  const lobbyParticipants = [{
    id: session?.participantId || 'self',
    name: isDemo ? (isHost ? 'Demo host' : 'Demo guest') : myParticipant?.name || (isHost ? 'Host' : 'Guest'),
    role: isHost ? 'host' : 'guest',
    source: mySource,
    isSelf: true,
    connected: isDemo || connectionStatus === 'connected',
  }];
  if (isDemo || partnerParticipant) {
    lobbyParticipants.push(isDemo ? {
      id: 'demo-partner',
      name: isHost ? 'Demo guest' : 'Demo host',
      role: isHost ? 'guest' : 'host',
      source: demoPartnerSource,
      connected: true,
      detail: `${isHost ? 'Following' : 'Leading'} at ${formatTime(currentSec)}`,
    } : {
      ...partnerParticipant,
      connected: partnerConnected,
      detail: partnerConnected
        ? `${partnerParticipant.ready ? 'Ready' : 'Loading'} · Reported ${formatTime(
            Math.round((partnerParticipant.reportedPositionMs || 0) / 1000)
          )}`
        : null,
    });
  }

  const progressPct = Math.min(100, (displaySec / Math.max(1, durationSec)) * 100);

  return (
    <div
      className={`duet-room relative min-h-screen overflow-x-hidden text-white transition-colors duration-700 ${themeConfig.bgBase}`}
      style={{ '--room-accent': themeConfig.accent }}
    >
      {/* Theme Living Ambient Stage */}
      <ThemeBackground theme={theme} />
      {/* Spotify Connect Modal */}
      <SpotifyConnectModal
        open={showSpotifyModal}
        onClose={() => setShowSpotifyModal(false)}
        onConnected={() => sendCommand('participant:update', { source: 'spotify' })}
        onDisconnected={() => {
          if (mySource === 'spotify') {
            sendCommand('participant:update', { source: 'youtube' });
          }
        }}
      />

      {/* Session Summary Modal */}
      {showSessionSummary && (
        <div className="room-dialog fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="room-dialog-surface mx-4 w-full max-w-sm rounded-3xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600/20 text-violet-400">
                <Clock className="h-6 w-6" />
              </div>
              <h3 className="mt-4 font-display text-xl font-bold text-white">Session Summary</h3>
              <p className="mt-1 text-sm text-zinc-400">Room {roomCode}</p>
            </div>
            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
                <span className="text-xs text-zinc-400">Duration</span>
                <span className="font-mono text-sm font-bold text-white">{sessionDurationStr}</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
                <span className="text-xs text-zinc-400">Tracks Played</span>
                <span className="font-mono text-sm font-bold text-white">{tracksPlayedCount}</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
                <span className="text-xs text-zinc-400">Queue Size</span>
                <span className="font-mono text-sm font-bold text-white">{queue.length} songs</span>
              </div>
              {!isDemo && (
                <div className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
                  <span className="text-xs text-zinc-400">Sync Corrections</span>
                  <span className="font-mono text-sm font-bold text-white">{syncMetrics.correctionCount}</span>
                </div>
              )}
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowSessionSummary(false)}
                className="flex-1 rounded-full border border-white/10 bg-white/5 py-2.5 text-xs font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
              >
                Stay
              </button>
              <button
                onClick={confirmLeave}
                className="flex-1 rounded-full bg-rose-600 py-2.5 text-xs font-semibold text-white hover:bg-rose-700 cursor-pointer"
              >
                Leave Room
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Privacy Notice Modal */}
      {showPrivacy && (
        <div className="room-dialog fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="room-dialog-surface mx-4 w-full max-w-sm rounded-3xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600/20 text-emerald-400">
                <Shield className="h-5 w-5" />
              </div>
              <h3 className="font-display text-lg font-bold text-white">Privacy & Data</h3>
            </div>
            <div className="mt-4 space-y-3 text-sm leading-relaxed text-zinc-400">
              <p><strong className="text-white">Rooms are ephemeral.</strong> When a room closes, all data — messages, queue, and session info — is permanently deleted.</p>
              <p><strong className="text-white">No accounts required.</strong> No persistent user data is stored. Session tokens exist only while a room is active.</p>
              <p><strong className="text-white">Chat is private.</strong> Messages are only visible to room participants and are never stored beyond the session.</p>
              <p><strong className="text-white">No tracking.</strong> Duet does not use cookies, analytics, or advertising trackers.</p>
            </div>
            <button
              onClick={() => setShowPrivacy(false)}
              className="mt-5 w-full rounded-full bg-white/10 py-2.5 text-xs font-semibold text-white hover:bg-white/15 cursor-pointer"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Pop-up Incoming Message / Join Notification */}
      {chatToast && (
        <div className="room-incoming fixed top-20 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] animate-fade-up sm:right-6">
          {chatToast.type === 'join_request' ? (
            <div className="rounded-2xl border border-violet-500/40 bg-zinc-900/95 p-3.5 shadow-2xl backdrop-blur-xl">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-bold text-white">{chatToast.name} wants to join</p>
                  <p className="mt-0.5 text-[11px] text-zinc-400">Source: {chatToast.source}</p>
                </div>
                <button
                  onClick={() => setChatToast(null)}
                  className="shrink-0 text-zinc-500 hover:text-white cursor-pointer"
                  aria-label="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  disabled={respondingToJoin}
                  onClick={() => respondToJoin(chatToast.id, false)}
                  className="flex-1 rounded-full border border-white/10 bg-white/5 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
                >
                  Decline
                </button>
                <button
                  disabled={respondingToJoin}
                  onClick={() => respondToJoin(chatToast.id, true)}
                  className="flex-1 rounded-full bg-violet-600 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 cursor-pointer"
                >
                  Accept
                </button>
              </div>
            </div>
          ) : (
            <div
              onClick={chatToast.type === 'joined' ? () => setChatToast(null) : openChatFromNotification}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  if (chatToast.type === 'joined') setChatToast(null);
                  else openChatFromNotification();
                }
              }}
              className="flex cursor-pointer items-start gap-3 rounded-2xl border border-violet-500/30 bg-zinc-900/95 p-3.5 shadow-2xl backdrop-blur-xl transition hover:border-violet-400/50 hover:bg-zinc-900"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600/20 text-violet-400">
                <MessageCircle className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-bold text-white">{chatToast.senderName}</p>
                  {chatToast.type !== 'joined' && (
                    <span className="text-[10px] font-medium text-violet-400">Tap to reply</span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-zinc-300">{chatToast.text}</p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setChatToast(null);
                }}
                className="shrink-0 text-zinc-500 hover:text-white cursor-pointer"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* m1/m2: confirmation toast (copy code, resync, remove, add) */}
      {toast && (
        <div role="status" className="room-toast fixed bottom-6 left-1/2 z-[70] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border border-white/10 bg-zinc-900/95 px-4 py-2 text-center text-xs font-semibold text-white shadow-2xl backdrop-blur-md">
          {toast}
        </div>
      )}

      {/* Floating Live Reactions */}
      <div className="pointer-events-none fixed right-6 bottom-24 z-50 flex flex-col items-end gap-2">
        {(isDemo ? demoReactions : reactions).map((r) => (
          <div
            key={r.id}
            className="animate-fade-up flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/90 px-3.5 py-1.5 text-sm shadow-xl backdrop-blur-md"
          >
            <span className="text-lg">{r.emoji}</span>
            <span className="text-xs font-semibold text-zinc-300">{r.senderName}</span>
          </div>
        ))}
      </div>

      {/* Header */}
      <header className="room-header sticky top-0 z-30 border-b border-white/5 bg-zinc-950/90 backdrop-blur-xl">
        {/* Room identity and actions */}
        <div className="room-header-row mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 sm:px-8">
          <div className="room-header-identity flex items-center gap-2">
            <button
              onClick={handleLeaveClick}
              className="room-header-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:bg-white/10 cursor-pointer"
              aria-label="Leave room"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <div className="room-wordmark flex shrink-0 items-center gap-1.5 sm:gap-2">
              <span className="room-brand-icon flex h-7 w-7 items-center justify-center rounded-lg bg-white text-zinc-950">
                <Radio className="h-3.5 w-3.5" />
              </span>
              <span className="font-display text-base font-bold tracking-tight">Duet</span>
            </div>

            {isDemo && (
              <span className="room-demo-badge shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-300 ring-1 ring-amber-500/30">
                DEMO
              </span>
            )}

            <button
              onClick={handleCopyCode}
              className="room-code inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-bold tracking-wider text-white transition hover:bg-white/10 cursor-pointer"
              title="Copy room code"
            >
              <span>{roomCode}</span>
              {copied ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3 text-zinc-500" />
              )}
            </button>
          </div>

          {/* Desktop theme controls */}
          <div className="room-desktop-themes order-3 flex w-full flex-wrap items-center gap-1.5 pt-1 lg:order-none lg:w-auto lg:pt-0">
            <Palette className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <div className="flex flex-wrap items-center gap-1 rounded-full border border-white/[0.08] bg-black/40 p-0.5 backdrop-blur-md shadow-inner shadow-black/40">
              {Object.keys(THEME_STYLES).map((t) => {
                const conf = THEME_STYLES[t] || THEME_STYLES.midnight;
                const isCurrent = theme === t;
                return (
                  <button
                    key={t}
                    onClick={() => changeTheme(t)}
                    aria-pressed={isCurrent}
                    disabled={!isDemo && !canControl}
                    className={`group relative flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-all duration-300 cursor-pointer ${
                      isCurrent
                        ? 'bg-white/15 text-white shadow-sm shadow-black/40 ring-1 ring-white/25 backdrop-blur-md'
                        : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                    }`}
                    style={
                      isCurrent
                        ? {
                            boxShadow: `0 0 16px ${conf.accent}33, inset 0 1px 0 rgba(255,255,255,0.2)`,
                          }
                        : undefined
                    }
                    title={canControl || isDemo ? `Switch theme to ${conf.name || t}` : 'The host chooses the room theme'}
                  >
                    <span
                      className={`h-2 w-2 rounded-full transition-transform duration-300 ${
                        isCurrent ? 'scale-110 shadow-sm' : 'opacity-70 group-hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: conf.accent,
                        boxShadow: isCurrent ? `0 0 8px ${conf.accent}` : undefined,
                      }}
                    />
                    <span>{conf.name || t}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="room-header-actions flex shrink-0 items-center gap-1.5 sm:gap-2">
            {!isDemo && (
              <button
                onClick={handleCopyInviteLink}
                className="room-invite inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-zinc-300 transition hover:bg-white/10 cursor-pointer"
                aria-label={copiedLink ? 'Invite link copied' : 'Copy invite link'}
              >
                <span className="sm:hidden">{copiedLink ? 'Copied!' : 'Invite'}</span>
                <span className="hidden sm:inline">{copiedLink ? 'Copied!' : 'Copy Invite Link'}</span>
              </button>
            )}

            {/* Sync Status */}
            <button
              onClick={() => setShowMetrics((m) => !m)}
              className="room-desktop-sync inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-400 sm:px-2.5 cursor-pointer"
              title="Synchronization metrics"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              <span className="hidden sm:inline">{syncLabel}</span>
              {!isDemo && partnerParticipant && <span className="text-emerald-400/80">{syncMetrics.rttMs}ms</span>}
            </button>

            {!isDemo && (
              <div className="room-header-menu relative flex items-center gap-1.5" data-notifications-menu>
                <button
                  onClick={() => {
                    setShowNotifications((n) => !n);
                    setShowSettings(false);
                    setShowMetrics(false);
                  }}
                  className="room-header-action relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:bg-white/10 cursor-pointer"
                  aria-label="Notifications"
                  aria-expanded={showNotifications}
                  title="Notifications"
                >
                  <Bell className="h-3.5 w-3.5" />
                  {(unreadChatCount + pendingJoins.length) > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[9px] font-bold text-white">
                      {unreadChatCount + pendingJoins.length > 9
                        ? '9+'
                        : unreadChatCount + pendingJoins.length}
                    </span>
                  )}
                </button>

                {showNotifications && (
                  <div className="room-notifications absolute top-10 right-0 z-50 w-72 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 p-2 shadow-2xl backdrop-blur-xl sm:w-80">
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-[11px] font-bold tracking-widest text-zinc-500 uppercase">Notifications</span>
                      {notifications.length > 0 && (
                        <button
                          onClick={() => {
                            setNotifications([]);
                            setUnreadChatCount(0);
                          }}
                          className="text-[11px] font-semibold text-zinc-400 hover:text-white cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {pendingJoins.length > 0 && (
                      <div className="mb-2 space-y-1.5 border-b border-white/5 pb-2">
                        {pendingJoins.map((req) => (
                          <div key={req.id} className="rounded-xl bg-violet-500/10 p-2.5">
                            <p className="text-xs font-bold text-white">{req.name} wants to join</p>
                            <p className="text-[11px] text-zinc-400">Source: {req.source}</p>
                            <div className="mt-2 flex gap-2">
                              <button
                                disabled={respondingToJoin}
                                onClick={() => respondToJoin(req.id, false)}
                                className="flex-1 rounded-full bg-white/5 py-1 text-[11px] font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
                              >
                                Decline
                              </button>
                              <button
                                disabled={respondingToJoin}
                                onClick={() => respondToJoin(req.id, true)}
                                className="flex-1 rounded-full bg-violet-600 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 cursor-pointer"
                              >
                                Accept
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {notifications.length === 0 && pendingJoins.length === 0 ? (
                      <p className="px-3 py-6 text-center text-xs text-zinc-500">No new notifications</p>
                    ) : (
                      <div className="max-h-64 space-y-1 overflow-y-auto">
                        {notifications.map((n) => (
                          <button
                            key={n.id}
                            onClick={() => {
                              if (n.type === 'joined') setShowNotifications(false);
                              else openChatFromNotification();
                            }}
                            className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left transition hover:bg-white/5 cursor-pointer"
                          >
                            <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-bold text-white">{n.senderName}</p>
                              <p className="truncate text-xs text-zinc-400">{n.text}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={() => {
                    setShowSettings((s) => !s);
                    setShowNotifications(false);
                    setShowMetrics(false);
                  }}
                  className={`room-header-action inline-flex h-8 w-8 items-center justify-center rounded-full border transition cursor-pointer ${
                    showSettings
                      ? 'border-white/30 bg-white text-zinc-950'
                      : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10'
                  }`}
                  aria-label="Room settings"
                  aria-expanded={showSettings}
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Demo perspective switcher */}
            {isDemo && (
              <div className="room-demo-roles inline-flex items-center rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  onClick={() => {
                    setDemoRole('host');
                    setDemoUnlocked(true);
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                    isHost ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Host
                </button>
                <button
                  onClick={() => setDemoRole('guest')}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                    !isHost ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Guest
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Expandable Sync Metrics */}
        {showMetrics && !isDemo && (
          <div id="room-sync-metrics" className="room-metrics border-t border-white/5 bg-zinc-900/80 px-4 py-2.5 sm:px-8">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 text-xs text-zinc-400">
              <div className="flex flex-wrap gap-5 font-mono">
                <span>RTT: <strong className="text-white">{syncMetrics.rttMs}ms</strong></span>
                <span>Clock Offset: <strong className="text-white">{syncMetrics.clockOffsetMs}ms</strong></span>
                <span>Est. Drift: <strong className="text-white">{syncMetrics.driftMs}ms</strong></span>
                <span>Corrections: <strong className="text-white">{syncMetrics.correctionCount}</strong></span>
                <span>Reconnects: <strong className="text-white">{syncMetrics.reconnectCount}</strong></span>
              </div>
              <button
                onClick={runClockSync}
                className="inline-flex items-center gap-1 font-semibold text-violet-400 hover:text-violet-300 cursor-pointer"
              >
                <RefreshCw className="h-3 w-3" /> Recalibrate Clock
              </button>
            </div>
          </div>
        )}

        {/* Settings drawer — toggled by Settings gear icon */}
        {showSettings && !isDemo && (
          <div className="room-settings border-t border-white/5 bg-zinc-950/70 px-4 py-2 sm:px-8">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
              {/* Settings checkboxes + actions */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {canControl && (
                  <>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none hover:text-zinc-200 transition">
                      <input
                        type="checkbox"
                        checked={Boolean(roomState?.settings?.allowGuestQueue)}
                        onChange={(e) =>
                          sendCommand('room:settings', { allowGuestQueue: e.target.checked })
                        }
                        className="accent-violet-500 h-3.5 w-3.5"
                      />
                      Allow guest to add songs
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none hover:text-zinc-200 transition">
                      <input
                        type="checkbox"
                        checked={Boolean(roomState?.settings?.allowGuestControl)}
                        onChange={(e) =>
                          sendCommand('room:settings', { allowGuestControl: e.target.checked })
                        }
                        className="accent-violet-500 h-3.5 w-3.5"
                      />
                      Allow guest full control
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none hover:text-zinc-200 transition">
                      <input
                        type="checkbox"
                        checked={Boolean(roomState?.settings?.requireApproval)}
                        onChange={(e) =>
                          sendCommand('room:settings', { requireApproval: e.target.checked })
                        }
                        className="accent-violet-500 h-3.5 w-3.5"
                      />
                      Require approval to join
                    </label>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowPrivacy(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-400 hover:bg-white/10 hover:text-white cursor-pointer transition"
                >
                  <Shield className="h-3 w-3" /> Privacy
                </button>
                {isHost && partnerParticipant && (
                  <button
                    onClick={() =>
                      armOrRun('host', () =>
                        sendCommand('room:transfer-host', {
                          targetParticipantId: partnerParticipant.id,
                        })
                      )
                    }
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold cursor-pointer transition ${
                      armedAction === 'host'
                        ? 'border-amber-500/50 bg-amber-500/20 text-amber-200'
                        : 'border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {armedAction === 'host' ? 'Tap again to make host' : `Make ${partnerParticipant.name} Host`}
                  </button>
                )}
                {isHost && (
                  <button
                    onClick={() => armOrRun('end', () => sendCommand('room:close', {}))}
                    className={`rounded-full px-3 py-1 text-[11px] font-bold text-white cursor-pointer transition ${
                      armedAction === 'end' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    {armedAction === 'end' ? 'Tap again to end room' : 'End Room'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="room-main relative z-10 mx-auto max-w-7xl px-3 py-4 sm:px-8 sm:py-8">
        {/* Errors */}
        {(roomError || playerError) && (
          <div role="alert" className="room-error mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            <span>{playerError?.message || roomError}</span>
            <div className="flex items-center gap-2">
              {playerError && ctxReloadPlayer && (
                <button
                  onClick={async () => {
                    setReloadingPlayer(true);
                    try {
                      const ok = await ctxReloadPlayer();
                      if (ok) showToast('Player reloaded — resuming playback');
                      else showToast('Player reload failed — try refreshing the page');
                    } finally {
                      setReloadingPlayer(false);
                    }
                  }}
                  disabled={reloadingPlayer}
                  className="rounded-full bg-white/15 px-3 py-1 font-semibold text-white hover:bg-white/25 disabled:opacity-50 cursor-pointer"
                >
                  {reloadingPlayer ? 'Reloading…' : 'Reload player'}
                </button>
              )}
              {playerError?.isEmbedBlocked && currentTrack && (
                <button
                  onClick={async () => {
                    setPlayerError(null);
                    const resolved = await resolveYouTubeTrack(currentTrack.title, currentTrack.artist);
                    if (resolved?.item?.youtubeId) {
                      const res = await sendCommand('queue:add', {
                        track: {
                          ...currentTrack,
                          youtubeId: resolved.item.youtubeId,
                          durationSec: resolved.item.durationSec || currentTrack.durationSec,
                        },
                      });
                      if (res?.ok) showToast('Found a playable version — added to queue');
                    } else {
                      navigateRoom('search');
                      setSearchQuery(`${currentTrack.title} ${currentTrack.artist}`);
                      setSearchError('No playable YouTube version found — paste a YouTube link instead');
                    }
                  }}
                  className="rounded-full bg-white/15 px-3 py-1 font-semibold text-white hover:bg-white/25 cursor-pointer"
                >
                  Find Embeddable Version
                </button>
              )}
              {playerError?.isEmbedBlocked && canControl && (
                <button
                  onClick={async () => {
                    setPlayerError(null);
                    await sendCommand('player:next', {});
                  }}
                  className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                >
                  Play next song
                </button>
              )}
              <button
                onClick={() => {
                  setPlayerError(null);
                  setRoomError(null);
                }}
                aria-label="Dismiss error"
                className="text-rose-300 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Mobile Browser Autoplay Unlock Banner */}
        {!audioUnlocked && (
          <div className="room-unlock mb-6 flex flex-col items-start justify-between gap-4 rounded-2xl border border-violet-500/30 bg-violet-500/10 p-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white">
                <Volume2 className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-bold text-white">Tap to unlock synced audio</p>
                <p className="text-xs text-zinc-300">
                  Mobile browsers require a tap gesture before syncing playback with your partner.
                </p>
              </div>
            </div>
            <button
              onClick={isDemo ? () => setDemoUnlocked(true) : unlockAudio}
              className="w-full rounded-full bg-violet-600 px-5 py-2.5 text-xs font-semibold text-white shadow transition hover:bg-violet-700 sm:w-auto cursor-pointer"
            >
              Tap to Join Audio
            </button>
          </div>
        )}

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-12 lg:items-start">
          {/* Left: Player */}
          <section className="room-listening min-w-0 space-y-4 sm:space-y-5 lg:col-span-7">
            <div className="room-player rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-2xl shadow-black/20 backdrop-blur-sm sm:p-8">
              <div className="room-player-heading">
                <div>
                  <h1 tabIndex={-1} ref={playerHeadingRef}>Now playing</h1>
                  {isDemo ? (
                    <span className="room-sync-status">Demo room</span>
                  ) : (
                    <button
                      type="button"
                      className="room-sync-status"
                      aria-controls="room-sync-metrics"
                      aria-expanded={showMetrics}
                      onClick={() => {
                        setShowSettings(false);
                        setShowNotifications(false);
                        setShowMetrics((open) => !open);
                        window.scrollTo({ top: 0, behavior: 'instant' });
                      }}
                    >
                      <span className="room-status-dot" data-status={ctxSyncStatus} aria-hidden="true" />
                      {syncLabel}
                    </button>
                  )}
                </div>
                <button
                  ref={themePickerRef}
                  type="button"
                  className="room-theme-trigger"
                  aria-expanded={showThemes}
                  aria-controls="room-theme-options"
                  aria-label={`Room theme: ${themeConfig.name}`}
                  onClick={() => setShowThemes((open) => !open)}
                >
                  <Palette size={20} aria-hidden="true" />
                  <span>
                    <span>Theme</span>
                    <strong>{themeConfig.name}</strong>
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
              <div
                id="room-theme-options"
                className="room-mobile-themes"
                role="group"
                aria-label="Room themes"
                hidden={!showThemes}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setShowThemes(false);
                    themePickerRef.current?.focus();
                  }
                }}
              >
                {!isDemo && !canControl && <p>The host chooses the room theme.</p>}
                {Object.values(THEME_STYLES).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={theme === option.id}
                    disabled={!isDemo && !canControl}
                    onClick={() => {
                      changeTheme(option.id);
                      setShowThemes(false);
                      themePickerRef.current?.focus();
                    }}
                  >
                    <span
                      className="room-theme-swatch"
                      style={{ backgroundColor: option.accent, backgroundImage: `url(/themes/${option.id}-thumb.webp)` }}
                      aria-hidden="true"
                    />
                    <span>{option.name}</span>
                    {theme === option.id && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
              </div>
              {/* Source Switcher */}
              <div className="room-source flex flex-col gap-3 border-b border-white/5 pb-4 sm:flex-row sm:items-center sm:justify-between sm:pb-5">
                <div>
                  <p className="room-source-role text-[11px] font-bold tracking-widest text-zinc-500 uppercase">
                    Your Phone ({isHost ? 'Host' : 'Guest'})
                  </p>
                  <p className="text-sm font-bold text-white">Playback Source</p>
                </div>
                <div role="group" aria-label="Playback source" className="room-source-options inline-flex w-full justify-between rounded-full border border-white/10 bg-white/5 p-1 sm:w-auto sm:justify-start">
                  <button
                    onClick={() => handleSourceSwitch('youtube')}
                    aria-pressed={mySource === 'youtube'}
                    className={`flex-1 rounded-full px-2.5 py-1.5 text-center text-xs font-semibold transition sm:flex-none sm:px-3.5 cursor-pointer ${
                      mySource === 'youtube' ? 'bg-red-600 text-white' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    YouTube
                  </button>
                  <button
                    onClick={() => handleSourceSwitch('audio')}
                    aria-pressed={mySource === 'audio' || mySource === 'local'}
                    className={`flex-1 rounded-full px-2.5 py-1.5 text-center text-xs font-semibold transition sm:flex-none sm:px-3.5 cursor-pointer ${
                      mySource === 'audio' || mySource === 'local' ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    Audio Only
                  </button>
                  <button
                    onClick={() => handleSourceSwitch('spotify')}
                    aria-pressed={mySource === 'spotify'}
                    title="Spotify Premium (Web Playback SDK)"
                    className={`flex-1 rounded-full px-2 py-1.5 text-center text-xs font-semibold transition sm:flex-none sm:px-3 cursor-pointer ${
                      mySource === 'spotify' ? 'bg-emerald-500 text-zinc-950 font-bold' : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    Spotify
                  </button>
                </div>
              </div>

              {pendingJoins.length > 0 && (
                <button
                  type="button"
                  className="room-lobby-notice"
                  onClick={() => navigateRoom('lobby')}
                >
                  <Users size={17} aria-hidden="true" />
                  {pendingJoins.length} waiting in the lobby
                </button>
              )}

              {/* Player Stage: Visible YouTube IFrame OR Audio-Only Visualizer */}
              {currentTrack && (
                <div className="room-stage relative mt-6 space-y-5">
                  {!isDemo && (mySource === 'youtube' || mySource === 'audio') && (
                    <div
                      aria-label={mySource === 'audio' ? `Audio Only — ${currentTrack.title} by ${currentTrack.artist}` : undefined}
                      className={
                        mySource === 'youtube'
                          ? 'room-video overflow-hidden rounded-2xl border border-white/10 bg-black'
                          : 'room-video pointer-events-none mx-auto min-h-[200px] w-full max-w-[360px] overflow-hidden rounded-2xl border border-white/10 bg-black'
                      }
                    >
                      <div ref={ytContainerRef} className="aspect-video min-h-[200px] w-full" />
                    </div>
                  )}

                  {(isDemo || mySource !== 'youtube') && (
                    <div className="room-track flex flex-col items-center gap-6 sm:flex-row">
                      <div className="room-artwork relative h-44 w-44 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/10 sm:h-48 sm:w-48">
                        {currentTrack.coverImage && (
                          <img src={currentTrack.coverImage} alt="" className="room-cover" loading="lazy" />
                        )}
                        <AudioVisualizerCanvas
                          isPlaying={isPlaying}
                          accentColor={currentTrack.accentColor || (THEME_STYLES[theme] || THEME_STYLES.midnight).accent}
                          secondaryColor={currentTrack.secondaryColor || (THEME_STYLES[theme] || THEME_STYLES.midnight).secondary || '#f43f5e'}
                          coverImage={currentTrack.coverImage}
                          className={`room-visualizer h-full w-full ${currentTrack.coverImage ? 'room-visualizer-with-cover' : ''}`}
                        />
                        {!currentTrack.coverImage && (
                          <div className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-br ${currentTrack.coverGradient || 'from-violet-600/40 to-rose-500/40'} text-white`}>
                            <Disc3 className={`h-16 w-16 opacity-90 ${isPlaying ? 'animate-rotate-disc' : ''}`} />
                          </div>
                        )}
                      </div>

                      <div className="room-track-details w-full flex-1 text-center sm:text-left">
                        <span className={`room-source-badge mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold tracking-wider uppercase ${
                          mySource === 'spotify'
                            ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                            : 'border-violet-500/30 bg-violet-500/15 text-violet-300'
                        }`}>
                          <Volume2 className="h-3 w-3" />{' '}
                          {mySource === 'spotify' ? 'Spotify Premium · Synced' : 'Audio Only · Background Play'}
                        </span>
                        <h2 className="room-track-title font-display text-2xl font-bold tracking-tight break-words text-white sm:text-3xl">
                          {currentTrack.title}
                        </h2>
                        <p className="mt-1 text-base font-medium text-zinc-400">{currentTrack.artist}</p>
                        {currentTrack.dedication && (
                          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-300">
                            <Heart className="h-3 w-3 fill-current" /> "{currentTrack.dedication}"
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {!isDemo && mySource === 'youtube' && (
                    <div className="room-video-details flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="room-track-title font-display text-xl font-bold break-words text-white">{currentTrack.title}</h2>
                        <p className="text-sm text-zinc-400">{currentTrack.artist}</p>
                      </div>
                      {currentTrack.dedication && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-300">
                          <Heart className="h-3 w-3 fill-current" /> "{currentTrack.dedication}"
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!currentTrack && (
                <div className="room-player-empty">
                  <Disc3 size={32} aria-hidden="true" />
                  <h2>No song playing</h2>
                  <button type="button" onClick={() => navigateRoom('search')}>Add a song</button>
                </div>
              )}

              {/* Scrubber */}
              {currentTrack && (
                <div className="room-progress mt-6">
                  <input
                    type="range"
                    min={0}
                    max={durationSec}
                    value={displaySec}
                    disabled={!canControl}
                    onChange={handleSeek}
                    onPointerUp={() => flushSeek()}
                    onMouseUp={() => flushSeek()}
                    onTouchEnd={() => flushSeek()}
                    aria-label="Track progress"
                    className={`room-range h-1.5 w-full appearance-none rounded-full accent-white ${
                      canControl ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                    }`}
                    style={{
                      '--room-range-fill': `${progressPct}%`,
                      background: `linear-gradient(to right, ${themeConfig.accent} ${progressPct}%, rgba(255,255,255,0.15) ${progressPct}%)`,
                    }}
                  />
                  <div className="mt-2 flex justify-between font-mono text-xs font-medium text-zinc-500">
                    <span>{formatTime(displaySec)}</span>
                    <span>{formatTime(durationSec)}</span>
                  </div>
                </div>
              )}

              {/* Transport */}
              <div className="room-transport mt-6 grid grid-cols-3 items-center gap-2">
                <div className="room-host-control flex items-center">
                  {!canControl && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-zinc-400">
                      <Lock className="h-3 w-3 shrink-0" />
                      <span className="room-host-label hidden sm:inline">Host controls</span>
                    </span>
                  )}
                </div>
                <div className="room-transport-buttons flex items-center justify-center gap-3">
                  <button onClick={() => handleStep(-1)} disabled={!canControl} aria-label="Previous" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer">
                    <SkipBack className="h-4 w-4" />
                  </button>
                  <button onClick={handlePlayPause} disabled={!canControl || playLoading} aria-label={playLoading ? 'Loading…' : isPlaying ? 'Pause' : 'Play'} className="room-play flex h-14 w-14 items-center justify-center rounded-full bg-white text-zinc-950 shadow-lg shadow-white/20 transition-all hover:bg-zinc-200 hover:shadow-white/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer">
                    {playLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : isPlaying ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 translate-x-0.5 fill-current" />}
                  </button>
                  <button onClick={() => handleStep(1)} disabled={!canControl} aria-label="Next" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer">
                    <SkipForward className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={handleResync}
                    className="room-resync inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-white cursor-pointer"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Resync
                  </button>
                </div>
              </div>

              {/* M3: Duet volume control (works for host and guest) + m3 loading note */}
              <div className="room-volume mt-4 flex items-center gap-3">
                <button
                  onClick={applyToggleMute}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  title={muted ? 'Unmute' : 'Mute'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:bg-white/10 cursor-pointer"
                >
                  {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((muted ? 0 : volume) * 100)}
                  onChange={(e) => applyVolume(Number(e.target.value) / 100)}
                  aria-label="Volume"
                  className="room-range h-1.5 flex-1 cursor-pointer appearance-none rounded-full accent-white"
                  style={{ '--room-range-fill': `${Math.round((muted ? 0 : volume) * 100)}%` }}
                />
                <span className="w-10 text-right font-mono text-xs font-semibold text-zinc-400">
                  {Math.round((muted ? 0 : volume) * 100)}%
                </span>
                {playLoading && <span className="text-xs font-semibold text-zinc-400">Loading…</span>}
              </div>

              {/* Live Reaction Bar */}
              {(
                <div className="room-reactions mt-5 flex flex-wrap items-center justify-center gap-1.5 border-t border-white/5 pt-4 sm:mt-6 sm:gap-2">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => handleSendReaction(emoji)}
                      className="rounded-full bg-white/5 px-2.5 py-1.5 text-base transition hover:scale-110 hover:bg-white/10 active:scale-95 sm:px-3 cursor-pointer"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Partner Mirror */}
            <div className="room-partner rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 shadow-xl shadow-black/10 backdrop-blur-sm sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3.5">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/5 text-zinc-300 ring-1 ring-white/10">
                    <Smartphone className="h-5 w-5" />
                  </div>
                  <div>
                    {isDemo ? (
                      <>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-white">{isHost ? 'Guest Phone (Demo)' : 'Host Phone (Demo)'}</p>
                          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-400 uppercase">
                            {demoPartnerSource}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {isHost ? 'Following at' : 'Leading at'}{' '}
                          <span className="font-mono font-semibold text-white">{formatTime(currentSec)}</span>
                        </p>
                      </>
                    ) : partnerParticipant ? (
                      <>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-white">
                            {partnerParticipant.name} ({partnerParticipant.role})
                          </p>
                          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-zinc-300 uppercase">
                            {partnerParticipant.source}
                          </span>
                          <span className={`h-2 w-2 rounded-full ${partnerConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {partnerConnected
                            ? `${partnerParticipant.ready ? 'Ready' : 'Loading'} • Reported ${formatTime(
                                Math.round((partnerParticipant.reportedPositionMs || 0) / 1000)
                              )}`
                            : 'Disconnected — waiting to reconnect'}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-bold text-white">Waiting for your partner</p>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          Share code <span className="font-mono font-semibold text-white">{roomCode}</span> or the invite link above.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                {isDemo && (
                  <button
                    onClick={switchDemoPartnerSource}
                    className="rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
                  >
                    Switch Source
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Queue, search, chat and lobby */}
          <section ref={rightPanelRef} className="room-activity min-w-0 lg:col-span-5">
            <div className="room-activity-surface flex flex-col rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 shadow-xl shadow-black/10 backdrop-blur-sm sm:p-6">
              <div className="room-activity-heading">
                <h2 ref={activityHeadingRef} tabIndex={-1}>{activityTitle}</h2>
                {activeTab === 'queue' && <span>{queue.length} {queue.length === 1 ? 'song' : 'songs'}</span>}
              </div>
              <div className="room-desktop-tabs flex items-center justify-between border-b border-white/5 pb-4">
                <div className="inline-flex flex-wrap rounded-2xl bg-white/5 p-1">
                  {ROOM_NAVIGATION.slice(1).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      aria-current={activeTab === id ? 'location' : undefined}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                        activeTab === id ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {id === 'queue' ? `Queue (${queue.length})` : label}
                      {badgeCount[id] > 0 && <span className="room-desktop-badge">{badgeCount[id]}</span>}
                    </button>
                  ))}
                </div>
              </div>

              {activeTab === 'lobby' && (
                <RoomLobby
                  participants={lobbyParticipants}
                  pendingJoins={pendingJoins}
                  canManage={canControl}
                  approvalRequired={Boolean(roomState?.settings?.requireApproval)}
                  onApprovalChange={(requireApproval) => sendCommand('room:settings', { requireApproval })}
                  respondingToJoin={respondingToJoin}
                  onRespondToJoin={respondToJoin}
                  onSwitchDemoSource={isDemo ? switchDemoPartnerSource : undefined}
                  invite={isDemo ? null : {
                    code: roomCode,
                    copiedCode: copied,
                    copiedLink,
                    onCopyCode: handleCopyCode,
                    onCopyLink: handleCopyInviteLink,
                  }}
                />
              )}

              {activeTab === 'search' && (
                <div className="mt-4 flex flex-col gap-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        // Pressing Enter adds the first result — pasting a
                        // YouTube link then hitting Enter is the main way to
                        // add a song, and previously Enter did nothing.
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          // A pasted YouTube link adds directly (no waiting
                          // for the search round-trip).
                          handleAddYouTubeLink(searchQuery).then((added) => {
                            if (!added && filteredCatalog.length > 0) {
                              handleAddTrack(filteredCatalog[0]);
                            }
                          });
                        }
                      }}
                      placeholder="Search or paste a YouTube link"
                      aria-label="Search songs or paste a YouTube link"
                      className="w-full rounded-2xl border border-white/10 bg-white/5 py-2.5 pr-4 pl-10 text-sm text-white placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
                    />
                  </div>
                  {!isDemo && !youtubeApiConfigured && (
                    <p className="text-[11px] text-amber-300/90">
                      Keyword search needs the YouTube API — paste any YouTube link to add a song.
                    </p>
                  )}
                  <input
                    type="text"
                    maxLength={120}
                    value={dedication}
                    onChange={(e) => setDedication(e.target.value)}
                    placeholder="Dedication (optional)"
                    aria-label="Dedication for this song (optional)"
                    className="w-full rounded-xl border border-white/5 bg-white/[0.03] px-3.5 py-2 text-xs text-white placeholder:text-zinc-600 focus:border-white/15 focus:outline-none"
                  />
                  {isSearching && <p role="status" className="text-xs text-zinc-400">Searching...</p>}
                  {searchError && <p role="status" className="text-xs text-rose-300">{searchError}</p>}

                  <div className="room-search-results space-y-2 overflow-y-auto pr-1">
                    {!isSearching && !searchError && filteredCatalog.length === 0 && (
                      <p className="room-empty-copy">
                        {searchQuery.trim() ? 'No songs found. Try another search or paste a YouTube link.' : 'Enter a song title, artist, or YouTube link.'}
                      </p>
                    )}
                    {filteredCatalog.map((track) => (
                      <div key={track.id} className="room-search-result flex items-center justify-between gap-3 rounded-2xl border border-white/5 p-2.5 hover:bg-white/[0.03]">
                        <div className="flex min-w-0 items-center gap-3">
                          {track.coverImage ? (
                            <img src={track.coverImage} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                          ) : (
                            <div className={`h-11 w-11 shrink-0 rounded-xl bg-gradient-to-br ${track.coverGradient || 'from-violet-600 to-rose-500'}`} />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-white">{track.title}</p>
                            <p className="truncate text-xs text-zinc-500">
                              {track.artist} • {formatTime(track.durationSec)}
                              {track.sourceAttribution ? ` • ${track.sourceAttribution}` : ''}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleAddTrack(track)}
                          aria-label={`Add ${track.title} to queue`}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 cursor-pointer"
                        >
                          <Plus className="h-3 w-3" /> <span className="room-add-label">Add to Queue</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'queue' && (
                <div className="room-queue mt-4 space-y-2 overflow-y-auto pr-1">
                  {queue.length === 0 && (
                    <div className="room-empty-copy">
                      <p>The queue is empty.</p>
                      <button type="button" onClick={() => navigateRoom('search')}>Add a song</button>
                    </div>
                  )}
                  {canControl && queue.length > 0 && !isDemo && (
                    <div className="flex justify-end pb-1">
                      <button
                        onClick={handleClearQueue}
                        className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-3 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/20 cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" /> Clear All
                      </button>
                    </div>
                  )}
                  {queue.map((item, idx) => {
                    const isCurr = item.queueItemId === currentQueueItemId;
                    const track = item.track;
                    return (
                      <div
                        key={item.queueItemId}
                        className={`room-queue-row group flex items-center justify-between gap-3 rounded-2xl p-2.5 transition ${
                          isCurr ? 'bg-white text-zinc-950 shadow-sm' : 'border border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'
                        } `}
                      >
                        <button
                          type="button"
                          disabled={!canControl}
                          aria-current={isCurr ? 'true' : undefined}
                        onClick={() => {
                          if (!canControl) return;
                          if (isDemo) {
                            setDemoIdx(idx);
                            setDemoTime(0);
                            setDemoPlaying(true);
                          } else {
                            sendCommand('queue:select', { queueItemId: item.queueItemId });
                          }
                        }}
                          className="room-queue-track flex min-w-0 flex-1 items-center gap-3 text-left enabled:cursor-pointer"
                        >
                          <span className="relative block h-11 w-11 shrink-0 overflow-hidden rounded-xl">
                            {track.coverImage ? (
                              <img src={track.coverImage} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <span className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${track.coverGradient || 'from-violet-600 to-rose-500'} text-white`}>
                                <Disc3 className="h-4 w-4 opacity-80" />
                              </span>
                            )}
                          </span>
                          <span className="block min-w-0">
                            <span className={`block truncate text-sm font-bold ${isCurr ? 'text-zinc-950' : 'text-white'}`}>
                              {track.title}
                            </span>
                            <span className={`block truncate text-xs ${isCurr ? 'text-zinc-600' : 'text-zinc-500'}`}>
                              {track.artist} • {formatTime(track.durationSec)}
                              {item.addedByName ? ` • by ${item.addedByName}` : ''}
                            </span>
                          </span>
                        </button>

                        {canControl && !isDemo && (
                          <div className="room-queue-actions flex items-center gap-1 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                            {idx > 0 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  sendCommand('queue:reorder', { fromIndex: idx, toIndex: idx - 1 });
                                }}
                                className={`rounded-full p-1 cursor-pointer focus-visible:opacity-100 ${isCurr ? 'text-zinc-600 hover:bg-zinc-200' : 'text-zinc-400 hover:bg-white/10'}`}
                                aria-label="Move up"
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {idx < queue.length - 1 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  sendCommand('queue:reorder', { fromIndex: idx, toIndex: idx + 1 });
                                }}
                                className={`rounded-full p-1 cursor-pointer focus-visible:opacity-100 ${isCurr ? 'text-zinc-600 hover:bg-zinc-200' : 'text-zinc-400 hover:bg-white/10'}`}
                                aria-label="Move down"
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveTrack(item.queueItemId);
                              }}
                              className={`rounded-full p-1 cursor-pointer focus-visible:opacity-100 ${isCurr ? 'text-zinc-600 hover:bg-zinc-200' : 'text-zinc-400 hover:bg-white/10'}`}
                              aria-label="Remove track"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === 'chat' && (
                <div className="room-chat mt-4 flex flex-col">
                  <div
                    ref={chatMessagesRef}
                    className="room-messages h-72 space-y-2.5 overflow-y-auto pr-1 sm:h-[390px]"
                    role="log"
                    aria-label="Room messages"
                    onScroll={(event) => {
                      const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
                      followChatRef.current = scrollHeight - scrollTop - clientHeight <= 48;
                    }}
                  >
                    {(chatMessages || []).length === 0 && (
                      <p className="py-12 text-center text-xs text-zinc-500">
                        {isDemo
                          ? 'Demo chat — messages are local-only in the demo.'
                          : 'Private room chat — messages clear when the room closes.'}
                      </p>
                    )}
                    {(chatMessages || []).map((msg) => {
                      const mine = isDemo
                        ? msg.senderId === 'demo-self'
                        : msg.senderId === session?.participantId;
                      const msgTime = msg.createdAtMs || msg.timestamp || msg.createdAt;
                      return (
                        <div key={msg.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                          <span className="mb-1 text-[10px] font-semibold text-zinc-500">
                            {msg.senderName}
                            {msgTime ? ` • ${new Date(msgTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                          </span>
                          <div
                            className={`room-message max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed ${
                              mine ? 'bg-violet-600 text-white' : 'bg-white/10 text-zinc-100'
                            }`}
                          >
                            {msg.text}
                          </div>
                        </div>
                      );
                    })}
                    {partnerTyping && (
                      <div className="flex flex-col items-start">
                        <div className="rounded-2xl bg-white/5 px-3.5 py-2 text-xs text-zinc-400">
                          <span className="inline-flex gap-0.5">
                            <span className="animate-bounce" style={{ animationDelay: '0s' }}>·</span>
                            <span className="animate-bounce" style={{ animationDelay: '0.15s' }}>·</span>
                            <span className="animate-bounce" style={{ animationDelay: '0.3s' }}>·</span>
                          </span>
                          {' '}typing
                        </div>
                      </div>
                    )}
                  </div>
                  <form onSubmit={handleSendChat} className="room-composer mt-3 flex items-center gap-2">
                    <input
                      type="text"
                      maxLength={500}
                      value={chatText}
                      onChange={handleChatInputChange}
                      placeholder="Message your partner..."
                      aria-label="Chat message"
                      className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white placeholder:text-zinc-500 focus:border-white/20 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-zinc-950 hover:bg-zinc-200 cursor-pointer"
                      aria-label="Send message"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  </form>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <nav className="room-mobile-nav" aria-label="Room navigation">
        {ROOM_NAVIGATION.map(({ id, label, icon: Icon }) => {
          const selected = activityInView ? id === activeTab : id === 'player';
          return (
            <button
              key={id}
              type="button"
              aria-current={selected ? 'location' : undefined}
              onClick={() => navigateRoom(id)}
            >
              <span className="room-nav-icon">
                <Icon size={20} aria-hidden="true" />
                {badgeCount[id] > 0 && (
                  <span className="room-unread">{badgeCount[id] > 9 ? '9+' : badgeCount[id]}</span>
                )}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
