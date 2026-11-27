import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { RoomProvider, useRoom } from './context/RoomContext';
import { handleSpotifyCallback } from './utils/spotifyAuth';

const LandingPage = lazy(() => import('./components/LandingPage'));
const RoomView = lazy(() => import('./components/RoomView'));

const LAST_ROOM_KEY = 'duet_last_room';
const SESSION_STORAGE_KEY = 'duet_active_session';

/* ——— Loading Spinner ——— */
function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        <span className="text-xs font-semibold text-zinc-500">Loading…</span>
      </div>
    </div>
  );
}

/* ——— PWA Install Prompt ——— */
// R7(a): the banner must not overlay room controls. It is rendered only on
// the landing / room-not-found screens (see DuetAppShell below), never
// inside a room view — so it unmounts when a room opens. The deferred
// prompt and the dismissed flag are cached at module scope so the banner
// can come back on the landing page after leaving a room (the
// beforeinstallprompt event only fires once per page load).
let cachedInstallPrompt = null;
let installBannerDismissed = false;

function PWAInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(() => cachedInstallPrompt);
  const [dismissed, setDismissed] = useState(() => installBannerDismissed);

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      cachedInstallPrompt = e;
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!deferredPrompt || dismissed) return null;

  const dismiss = () => {
    installBannerDismissed = true;
    setDismissed(true);
  };

  const handleInstall = async () => {
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      cachedInstallPrompt = null;
      setDeferredPrompt(null);
    }
    dismiss();
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-fade-up rounded-2xl border border-white/10 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur-xl sm:left-auto sm:right-6 sm:w-96">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-bold text-white">Install Duet</p>
          <p className="mt-0.5 text-xs text-zinc-400">Add to your home screen for the best experience — instant launch, fullscreen, home-screen icon.</p>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-zinc-500 hover:text-white cursor-pointer"
          aria-label="Dismiss"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={dismiss}
          className="flex-1 rounded-full border border-white/10 bg-white/5 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
        >
          Not now
        </button>
        <button
          onClick={handleInstall}
          className="flex-1 rounded-full bg-violet-600 py-2 text-xs font-semibold text-white hover:bg-violet-700 cursor-pointer"
        >
          Install
        </button>
      </div>
    </div>
  );
}

/* ——— M7: dedicated screen for a room link that does not exist / expired.
   The URL stays at /room/<code>; this is NOT the landing page with a tiny
   error line. ——— */
function RoomNotFoundScreen({ code, onCreateRoom, onJoinRoom, roomLoading }) {
  const [joinCode, setJoinCode] = useState('');
  const [joinErr, setJoinErr] = useState('');

  const handleJoin = (e) => {
    e.preventDefault();
    const c = joinCode.trim().toUpperCase();
    if (c.length !== 6) {
      setJoinErr('Enter the 6-character room code');
      return;
    }
    setJoinErr('');
    onJoinRoom(c, 'youtube');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-5 text-white">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-rose-500/15 text-rose-400">
          <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
        <h1 className="mt-6 font-display text-3xl font-bold tracking-tight">
          This room doesn&apos;t exist or has expired
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          The link for room <span className="font-mono font-bold text-white">{code}</span> didn&apos;t
          lead anywhere. Rooms close when the host leaves, so the code may have
          expired — check the code, ask the host for a new link, or start your own room.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={() => onCreateRoom('youtube')}
            disabled={roomLoading}
            className="rounded-full bg-white px-6 py-3 text-sm font-bold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50 cursor-pointer"
          >
            {roomLoading ? 'Creating your room…' : 'Start a new room'}
          </button>
          <button
            onClick={() => {
              if (window.location.pathname !== '/') {
                window.history.replaceState(null, '', '/');
              }
              window.location.reload();
            }}
            className="rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10 cursor-pointer"
          >
            Back to home
          </button>
        </div>
        {roomLoading && (
          <p className="mt-3 text-xs text-zinc-500">
            Creating your room… this can take up to ~60 seconds while the server wakes up.
          </p>
        )}
        <form onSubmit={handleJoin} className="mx-auto mt-8 flex max-w-sm items-center rounded-full border border-white/10 bg-white/5 p-1 pl-4 backdrop-blur-sm transition focus-within:border-white/25">
          <input
            type="text"
            maxLength={8}
            value={joinCode}
            onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setJoinErr(''); }}
            placeholder="Try another code"
            aria-label="Room code"
            className="w-full bg-transparent text-sm font-medium tracking-wider text-white uppercase placeholder:normal-case placeholder:tracking-normal placeholder:text-zinc-500 focus:outline-none"
          />
          <button type="submit" disabled={roomLoading} className="shrink-0 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50 cursor-pointer">
            Join
          </button>
        </form>
        {joinErr && <p className="mt-2 text-xs font-medium text-rose-400">{joinErr}</p>}
      </div>
    </div>
  );
}

function DuetAppShell() {
  const {
    roomState,
    roomError,
    pendingApproval,
    createRoom,
    joinRoom,
    clearRoomError,
    setRoomError,
  } = useRoom();
  const [demoActive, setDemoActive] = useState(false);
  // M6: the track a trending card asked the demo to start with (null = default).
  const [demoTrack, setDemoTrack] = useState(null);
  // M9: demo state lives here so leaving/re-entering the demo preserves its
  // paused state, track, queue and chat while the page is open.
  const [demoState, setDemoState] = useState(null);
  const [roomLoading, setRoomLoading] = useState(false);
  const [spotifyCallbackError, setSpotifyCallbackError] = useState('');
  const [roomNotFound, setRoomNotFound] = useState(null);
  const [isHandlingSpotifyCallback, setIsHandlingSpotifyCallback] = useState(
    () => window.location.pathname === '/spotify-callback'
  );
  const [lastRoomCode, setLastRoomCode] = useState(() => {
    try {
      return localStorage.getItem(LAST_ROOM_KEY) || '';
    } catch {
      return '';
    }
  });
  const joinAttemptedRef = useRef(null);

  const clearError = () => {
    if (typeof clearRoomError === 'function') clearRoomError();
    else if (typeof setRoomError === 'function') setRoomError(null);
  };

  // Handle /spotify-callback OAuth PKCE redirect
  useEffect(() => {
    if (!isHandlingSpotifyCallback) return;
    handleSpotifyCallback(window.location.search)
      .then(({ returnPath }) => {
        window.history.replaceState(null, '', returnPath || '/');
        setIsHandlingSpotifyCallback(false);
      })
      .catch((err) => {
        setSpotifyCallbackError(err.message || 'Spotify login failed');
        window.history.replaceState(null, '', '/');
        setIsHandlingSpotifyCallback(false);
      });
  }, [isHandlingSpotifyCallback]);

  // M7: clear any stale room error when the landing page mounts.
  useEffect(() => {
    clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle /room/:code invitation links
  useEffect(() => {
    if (isHandlingSpotifyCallback) return;
    const match = /^\/room\/([A-Z2-9]{6})$/i.exec(window.location.pathname);
    if (!match) return;
    const code = match[1].toUpperCase();
    if (joinAttemptedRef.current === code) return;
    joinAttemptedRef.current = code;
    setRoomLoading(true);
    // M4 (client part): reuse the stored session for this room so the server
    // reuses the existing participant instead of returning ROOM_FULL.
    let sessionToken;
    try {
      const stored = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
      if (stored?.roomCode === code && stored?.sessionToken) {
        sessionToken = stored.sessionToken;
      }
    } catch {
      // Ignore malformed stored session
    }
    joinRoom({ roomCode: code, name: 'Guest', source: 'youtube', sessionToken })
      .then(() => setRoomNotFound(null))
      .catch((err) => {
        if (/not found|expired|ROOM_NOT_FOUND/i.test(err?.message || roomError || '')) {
          setRoomNotFound(code);
        }
      })
      .finally(() => setRoomLoading(false));
  }, [joinRoom, isHandlingSpotifyCallback]);

  useEffect(() => {
    if (roomState?.roomCode) {
      setRoomNotFound(null);
      try {
        localStorage.setItem(LAST_ROOM_KEY, roomState.roomCode);
        setLastRoomCode(roomState.roomCode);
      } catch {
        // Ignore
      }
      if (window.location.pathname !== `/room/${roomState.roomCode}`) {
        window.history.replaceState(null, '', `/room/${roomState.roomCode}`);
      }
    }
  }, [roomState?.roomCode]);

  const handleCreateRoom = async (source = 'youtube') => {
    setRoomLoading(true);
    setRoomNotFound(null);
    try {
      await createRoom({ name: 'Host', source });
    } catch {
      // Handled by roomError
    } finally {
      setRoomLoading(false);
    }
  };

  const handleJoinRoom = async (code, source = 'youtube') => {
    setRoomLoading(true);
    setRoomNotFound(null);
    try {
      await joinRoom({ roomCode: code, name: 'Guest', source });
    } catch (err) {
      if (/not found|expired|ROOM_NOT_FOUND/i.test(err?.message || '')) {
        setRoomNotFound(code.trim().toUpperCase());
      }
      // Other errors are handled by roomError
    } finally {
      setRoomLoading(false);
    }
  };

  const handleOpenDemo = (track) => {
    // M6: a trending card starts a fresh demo with THAT track. Opening the
    // plain demo (no track) preserves the previous demo state (M9).
    setDemoTrack(track || null);
    if (track) setDemoState(null);
    setRoomNotFound(null);
    setDemoActive(true);
  };

  const handleLeave = () => {
    setDemoActive(false);
    setRoomNotFound(null);
    clearError();
    if (window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
  };

  if (isHandlingSpotifyCallback) {
    return <LoadingFallback />;
  }

  if (demoActive) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <RoomView
          isDemo
          onLeave={handleLeave}
          demoTrack={demoTrack}
          demoState={demoState}
          onDemoStateChange={setDemoState}
        />
      </Suspense>
    );
  }

  if (roomState) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <RoomView isDemo={false} onLeave={handleLeave} />
      </Suspense>
    );
  }

  if (roomNotFound) {
    return (
      <>
        <RoomNotFoundScreen
          code={roomNotFound}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          roomLoading={roomLoading}
        />
        {/* R7(a): banner is fine here — this is not a room view. */}
        <PWAInstallBanner />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<LoadingFallback />}>
        <LandingPage
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onOpenDemo={handleOpenDemo}
          lastRoomCode={lastRoomCode}
          roomLoading={roomLoading}
          roomError={spotifyCallbackError || roomError}
          pendingApproval={pendingApproval}
        />
      </Suspense>
      {/* R7(a): banner is fine here — this is not a room view. */}
      <PWAInstallBanner />
    </>
  );
}

export default function App() {
  return (
    <RoomProvider>
      <DuetAppShell />
    </RoomProvider>
  );
}
