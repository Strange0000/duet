import React, { lazy, Suspense, useEffect, useState } from 'react';
import { RoomProvider, useRoom } from './context/RoomContext';
import { handleSpotifyCallback } from './utils/spotifyAuth';

const LandingPage = lazy(() => import('./components/LandingPage'));
const RoomView = lazy(() => import('./components/RoomView'));

const LAST_ROOM_KEY = 'duet_last_room';

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
function PWAInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!deferredPrompt || dismissed) return null;

  const handleInstall = async () => {
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      setDeferredPrompt(null);
    }
    setDismissed(true);
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
          onClick={() => setDismissed(true)}
          className="shrink-0 text-zinc-500 hover:text-white cursor-pointer"
          aria-label="Dismiss"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => setDismissed(true)}
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

function DuetAppShell() {
  const { roomState, roomError, pendingApproval, createRoom, joinRoom } = useRoom();
  const [demoActive, setDemoActive] = useState(false);
  const [roomLoading, setRoomLoading] = useState(false);
  const [spotifyCallbackError, setSpotifyCallbackError] = useState('');
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

  // Handle /room/:code invitation links
  useEffect(() => {
    if (isHandlingSpotifyCallback) return;
    const match = /^\/room\/([A-Z2-9]{6})$/i.exec(window.location.pathname);
    if (match) {
      const code = match[1].toUpperCase();
      setRoomLoading(true);
      joinRoom({ roomCode: code, name: 'Guest', source: 'youtube' })
        .catch(() => {})
        .finally(() => setRoomLoading(false));
    }
  }, [joinRoom, isHandlingSpotifyCallback]);

  useEffect(() => {
    if (roomState?.roomCode) {
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
    try {
      await joinRoom({ roomCode: code, name: 'Guest', source });
    } catch {
      // Handled by roomError
    } finally {
      setRoomLoading(false);
    }
  };

  const handleLeave = () => {
    setDemoActive(false);
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
        <RoomView isDemo onLeave={handleLeave} />
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

  return (
    <Suspense fallback={<LoadingFallback />}>
      <LandingPage
        onCreateRoom={handleCreateRoom}
        onJoinRoom={handleJoinRoom}
        onOpenDemo={() => setDemoActive(true)}
        lastRoomCode={lastRoomCode}
        roomLoading={roomLoading}
        roomError={spotifyCallbackError || roomError}
        pendingApproval={pendingApproval}
      />
    </Suspense>
  );
}

export default function App() {
  return (
    <RoomProvider>
      <DuetAppShell />
      <PWAInstallBanner />
    </RoomProvider>
  );
}
