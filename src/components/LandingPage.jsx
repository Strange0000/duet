import React, { useEffect, useState, useRef } from 'react';
import {
  ArrowRight,
  ChevronDown,
  Disc3,
  Headphones,
  Music,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Share2,
  Smartphone,
  Sparkles,
  Users,
  Volume2,
  Zap,
} from 'lucide-react';
import { INITIAL_TRACKS, SEARCH_CATALOG, formatTime } from '../data/mockTracks';
import { fetchSongArtwork } from '../utils/artworkApi';
import { getStoredSpotifyAuth } from '../utils/spotifyAuth';
import AudioVisualizerCanvas from './AudioVisualizerCanvas';
import SpotifyConnectModal from './SpotifyConnectModal';

/* ——— Animated equalizer bars ——— */
function EqBars({ active = true, colorClass = 'bg-white' }) {
  return (
    <span className="inline-flex h-3.5 items-end gap-0.5" aria-hidden>
      {[0, 0.2, 0.4, 0.15].map((d, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full ${colorClass} ${active ? 'eq-bar' : ''}`}
          style={{ height: active ? '100%' : '35%', animationDelay: `${d}s` }}
        />
      ))}
    </span>
  );
}

/* ——— Feature card data ——— */
const FEATURES = [
  {
    icon: Share2,
    title: 'Create & Share',
    body: 'Tap once to create a room. Share a 6-character code or invite link—no sign-up for guests.',
    gradient: 'from-violet-600 to-fuchsia-600',
  },
  {
    icon: Users,
    title: 'Pick Your Source',
    body: 'Each person chooses YouTube (free). Spotify is available but requires your own developer app (Client ID) and a Premium account.',
    gradient: 'from-emerald-500 to-cyan-500',
  },
  {
    icon: Zap,
    title: 'Instant Sync',
    body: 'Clock-compensated playback, typically within a second. Seek, pause, skip—both phones react together.',
    gradient: 'from-orange-500 to-rose-500',
  },
];

/* ——— FAQ data ——— */
const FAQS = [
  {
    q: 'Does my friend need Spotify Premium?',
    a: 'No — your friend can use YouTube for free. If either person wants Spotify, they need their own Spotify developer app (Client ID) and a Premium account. YouTube works for everyone with no setup.',
  },
  {
    q: 'Does it work on iPhone and Android?',
    a: 'Yes. YouTube plays in-browser on both iOS Safari and Android Chrome. Spotify works on desktop and Android via Web Playback SDK.',
  },
  {
    q: 'What if the YouTube video has a different intro length?',
    a: 'Duet uses clock-compensated sync: each phone measures its clock against the server, so both stay aligned to the same second without any manual offset. If drift ever creeps in, one tap on Resync snaps both phones back together.',
  },
  {
    q: 'Why do guests see a "Tap to Join Audio" button?',
    a: 'Mobile browsers block unmuted autoplay until you tap once. That single tap unlocks audio and snaps you to the host\'s timestamp.',
  },
];

const TRENDING_SONGS = [
  { img: '/cover-midnight.jpg', title: 'Midnight City', artist: 'M83', hot: true },
  { img: '/cover-instant.jpg', title: 'Instant Crush', artist: 'Daft Punk', hot: false },
  { img: '/cover-resonance.jpg', title: 'Resonance', artist: 'HOME', hot: true },
  { img: '/cover-synth.jpg', title: 'Blinding Lights', artist: 'The Weeknd', hot: true },
  { img: 'https://i.ytimg.com/vi/Kp7eSUU9oy8/hqdefault.jpg', title: 'Redbone', artist: 'Childish Gambino', hot: false },
  { img: '/cover-indie.jpg', title: 'The Less I Know The Better', artist: 'Tame Impala', hot: true },
  { img: '/cover-synth.jpg', title: 'Starboy', artist: 'The Weeknd', hot: false },
  { img: '/cover-instant.jpg', title: 'After Dark', artist: 'Mr.Kitty', hot: true },
  { img: '/cover-indie.jpg', title: 'Dreams', artist: 'Fleetwood Mac', hot: false },
  { img: '/cover-soul.jpg', title: 'Sweater Weather', artist: 'The Neighbourhood', hot: false },
];

/* m5: turn a bare server/join error into a friendly message with a next step. */
function friendlyRoomError(err) {
  if (!err) return '';
  const text = String(err);
  if (/not found|expired|ROOM_NOT_FOUND/i.test(text)) {
    return 'Room not found or expired. Check the code, ask the host for a new link, or start your own room.';
  }
  if (/full|ROOM_FULL/i.test(text)) {
    return 'That room is already full (2 people max). Ask the host for a new link, or start your own room.';
  }
  return text;
}

const TRENDING_GRADIENTS = [
  'from-violet-600 via-fuchsia-500 to-orange-400',
  'from-slate-900 via-indigo-800 to-cyan-500',
  'from-rose-500 via-purple-600 to-indigo-700',
  'from-red-600 via-rose-600 to-amber-500',
  'from-amber-400 via-orange-500 to-pink-600',
  'from-zinc-900 via-violet-900 to-fuchsia-700',
  'from-sky-500 via-blue-700 to-indigo-950',
  'from-emerald-500 via-teal-600 to-cyan-700',
];

/* M6: map a trending card to a real built-in track when one exists, so the
   demo opens with THAT track — not always Midnight City. */
function resolveTrendingTrack(song, index = 0) {
  const found = [...INITIAL_TRACKS, ...SEARCH_CATALOG].find(
    (t) => t.title.toLowerCase() === song.title.toLowerCase()
  );
  if (found) return found;
  return {
    id: `trend-${song.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title: song.title,
    artist: song.artist,
    album: 'Single',
    durationSec: 210,
    coverImage: song.img,
    coverGradient: TRENDING_GRADIENTS[index % TRENDING_GRADIENTS.length],
    accentColor: '#7c3aed',
    secondaryColor: '#f43f5e',
    youtubeId: null,
    spotifyUri: null,
  };
}

/* ——— Scroll-reveal hook ——— */
function useReveal() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, visible];
}

export default function LandingPage({
  onCreateRoom,
  onJoinRoom,
  onOpenDemo,
  lastRoomCode,
  roomLoading,
  roomError,
  pendingApproval,
}) {
  const [joinCode, setJoinCode] = useState('');
  const [joinErr, setJoinErr] = useState('');
  const [openFaq, setOpenFaq] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [spotifyModalOpen, setSpotifyModalOpen] = useState(false);
  const [connectedSource, setConnectedSource] = useState(() => getStoredSpotifyAuth()?.accessToken ? 'spotify' : 'youtube');
  const [spotifyAuth, setSpotifyAuth] = useState(() => getStoredSpotifyAuth());
  const [trendingSongs, setTrendingSongs] = useState(TRENDING_SONGS);
  const trendingRef = useRef(null);
  const scrollTrending = (dir) => {
    trendingRef.current?.scrollBy({ left: dir * 480, behavior: 'smooth' });
  };

  /* Fetch real album art via free iTunes Search API */
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      TRENDING_SONGS.map(async (song) => {
        const realImg = await fetchSongArtwork(song.title, song.artist);
        return realImg ? { ...song, img: realImg } : song;
      })
    ).then((updated) => {
      if (!cancelled) setTrendingSongs(updated);
    });
    return () => { cancelled = true; };
  }, []);

  /* Mini sync playground */
  const [demoIdx, setDemoIdx] = useState(0);
  const [demoPlay, setDemoPlay] = useState(true);
  const [demoTime, setDemoTime] = useState(102);
  const demoTrack = INITIAL_TRACKS[demoIdx] || INITIAL_TRACKS[0];

  useEffect(() => {
    if (!demoPlay) return;
    const t = setInterval(() => setDemoTime((v) => (v + 1 >= demoTrack.durationSec ? 0 : v + 1)), 1000);
    return () => clearInterval(t);
  }, [demoPlay, demoTrack.durationSec]);

  const demoPct = Math.min(100, (demoTime / demoTrack.durationSec) * 100);

  /* Close connect dropdown on outside click */
  useEffect(() => {
    if (!connectOpen) return;
    const handler = (e) => {
      if (!e.target.closest('[data-connect-dropdown]')) setConnectOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [connectOpen]);

  const handleJoin = (e) => {
    e.preventDefault();
    const c = joinCode.trim().toUpperCase();
    if (c.length !== 6) { setJoinErr('Enter the 6-character room code'); return; }
    setJoinErr('');
    onJoinRoom(c, connectedSource);
  };

  /* scroll-reveal refs */
  const [featRef, featVis] = useReveal();
  const [playRef, playVis] = useReveal();
  const [lifeRef, lifeVis] = useReveal();
  const [faqRef, faqVis] = useReveal();

  return (
    <div className="min-h-screen bg-zinc-950 text-white overflow-x-hidden">
      <SpotifyConnectModal
        open={spotifyModalOpen}
        onClose={() => setSpotifyModalOpen(false)}
        onConnected={() => {
          setSpotifyAuth(getStoredSpotifyAuth());
          setConnectedSource('spotify');
        }}
        onDisconnected={() => {
          setSpotifyAuth(null);
          if (connectedSource === 'spotify') setConnectedSource('youtube');
        }}
      />
      {/* ───────── NAV ───────── */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-3 sm:px-8 sm:py-3.5">
          <a href="#" className="flex shrink-0 items-center gap-2 group sm:gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-zinc-950 shadow-sm transition-transform group-hover:scale-105 sm:h-9 sm:w-9">
              <Radio className="h-4 w-4" />
            </span>
            <span className="font-display text-lg font-bold tracking-tight sm:text-xl">Duet</span>
          </a>
          <nav className="hidden items-center gap-7 text-sm font-medium text-zinc-400 md:flex">
            <a href="#features"   className="transition hover:text-white">Features</a>
            <a href="#playground" className="transition hover:text-white">Live Sync</a>
            <a href="#story"      className="transition hover:text-white">Story</a>
            <a href="#faq"        className="transition hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <button onClick={() => onOpenDemo()} className="hidden rounded-full px-4 py-2 text-sm font-semibold text-zinc-400 transition hover:text-white sm:inline-flex cursor-pointer">
              Live Demo
            </button>

            {/* Connect Source Dropdown */}
            <div className="relative" data-connect-dropdown>
              <button
                onClick={() => setConnectOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition sm:gap-2 sm:px-4 sm:py-2.5 sm:text-sm cursor-pointer ${
                  connectedSource === 'youtube'
                    ? 'border-red-500/30 bg-red-500/10 text-red-400'
                    : connectedSource === 'spotify'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${
                  connectedSource === 'youtube'
                    ? 'bg-red-500'
                    : connectedSource === 'spotify'
                      ? 'bg-emerald-500'
                      : 'bg-violet-400'
                }`} />
                {connectedSource === 'youtube' ? 'YouTube' : 'Audio Only'}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${connectOpen ? 'rotate-180' : ''}`} />
              </button>

              {connectOpen && (
                <div className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 p-2 shadow-2xl shadow-black/40 backdrop-blur-xl sm:w-76">
                  <p className="px-3 py-2 text-[11px] font-bold tracking-widest text-zinc-500 uppercase">Choose playback source</p>

                  {/* YouTube option */}
                  <button
                    onClick={() => { setConnectedSource('youtube'); setConnectOpen(false); }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition cursor-pointer ${
                      connectedSource === 'youtube' ? 'bg-red-500/10' : 'hover:bg-white/5'
                    }`}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-600 text-white shadow">
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-white">YouTube</span>
                        {connectedSource === 'youtube' && <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-400">Active</span>}
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">Official IFrame Player • Free</p>
                    </div>
                  </button>

                  {/* Audio Only via Spotify Premium */}
                  <button
                    onClick={() => {
                      setConnectOpen(false);
                      if (spotifyAuth?.accessToken) {
                        setConnectedSource('spotify');
                      } else {
                        setSpotifyModalOpen(true);
                      }
                    }}
                    className={`mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition cursor-pointer ${
                      connectedSource === 'spotify' ? 'bg-emerald-500/10' : 'hover:bg-white/5'
                    }`}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 shadow">
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-white">Audio Only</span>
                        {connectedSource === 'spotify' ? (
                          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">Active</span>
                        ) : spotifyAuth?.accessToken ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">Connected</span>
                        ) : (
                          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-zinc-300">Premium</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {spotifyAuth?.user?.displayName
                          ? `Signed in as ${spotifyAuth.user.displayName}`
                          : 'Original tracks via Spotify Premium'}
                      </p>
                    </div>
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={() => onCreateRoom(connectedSource)}
              disabled={roomLoading}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-xs font-semibold text-zinc-950 shadow-sm transition-all hover:bg-zinc-200 active:scale-[0.97] disabled:opacity-50 sm:gap-2 sm:px-5 sm:py-2.5 sm:text-sm cursor-pointer"
            >
              {roomLoading ? 'Creating your room…' : 'Start a Room'} <ArrowRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </button>
          </div>
        </div>
      </header>

      <main>
        {/* ───────── HERO ───────── */}
        <section className="relative overflow-hidden">
          {/* Background: dark abstract light art */}
          <div className="absolute inset-0 z-0">
            <img src="/dark-bg.jpg" alt="" className="h-full w-full object-cover opacity-50" />
            <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/40 via-zinc-950/70 to-zinc-950" />
          </div>

          <div className="relative z-10 mx-auto max-w-6xl px-5 pt-16 pb-20 sm:px-8 sm:pt-24 sm:pb-28">
            <div className="mx-auto max-w-3xl text-center">
              {/* Animated shimmer headline */}
              <h1 className="animate-fade-up font-display text-4xl font-extrabold tracking-[-0.04em] text-balance sm:text-7xl sm:leading-[1.05]">
                <span className="shimmer-text">Two phones.</span>{' '}
                <span className="text-white">One song.</span><br />
                <span className="text-white">Same second.</span>
              </h1>

              <p className="animate-fade-up-d1 mx-auto mt-5 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
                Listen together in one room. Each person picks{' '}
                <span className="font-semibold text-white">YouTube</span> (free) or{' '}
                <span className="font-semibold text-white">Spotify</span>{' '}
                <span className="text-zinc-500">(requires your own developer app + Premium)</span>. The host
                presses play—both phones follow at the exact same second.
              </p>

              {/* CTAs */}
              <div className="animate-fade-up-d2 mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <button
                  onClick={() => onCreateRoom(connectedSource)}
                  disabled={roomLoading}
                  className="gradient-border inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-white px-7 py-3.5 text-sm font-bold text-zinc-950 shadow-lg shadow-violet-600/20 transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 sm:w-auto cursor-pointer"
                >
                  <Play className="h-4 w-4 fill-current" />
                  {roomLoading ? 'Creating your room…' : 'Create a Room'}
                </button>
                <form onSubmit={handleJoin} className="flex w-full items-center rounded-full border border-white/10 bg-white/5 p-1 pl-4 backdrop-blur-sm transition focus-within:border-white/25 focus-within:bg-white/10 sm:w-auto">
                  <input
                    type="text" maxLength={8} value={joinCode}
                    onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setJoinErr(''); }}
                    placeholder="Enter room code" aria-label="Room code"
                    className="w-full bg-transparent text-sm font-medium tracking-wider text-white uppercase placeholder:normal-case placeholder:tracking-normal placeholder:text-zinc-500 focus:outline-none sm:w-36"
                  />
                  <button type="submit" disabled={roomLoading} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50 cursor-pointer">Join</button>
                </form>
              </div>
              {roomLoading && (
                <p className="mt-3 text-xs font-medium text-zinc-400">
                  Creating your room… this can take up to ~60 seconds while the server wakes up.
                </p>
              )}
              {(joinErr || roomError) && <p className="mt-2 text-xs font-medium text-rose-400">{joinErr || friendlyRoomError(roomError)}</p>}
              {pendingApproval && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/15 px-4 py-1.5 text-xs font-semibold text-violet-200">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
                  Waiting for host approval to join {pendingApproval.roomCode}…
                </div>
              )}

              <div className="animate-fade-up-d2 mt-4 flex flex-wrap items-center justify-center gap-4">
                <button onClick={() => onOpenDemo()} className="text-xs font-semibold text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition hover:text-white cursor-pointer">
                  Preview Demo Mode (Offline)
                </button>
                {lastRoomCode && (
                  <button onClick={() => onJoinRoom(lastRoomCode, connectedSource)} className="inline-flex items-center gap-1.5 rounded-full bg-violet-600/20 px-3 py-1 text-xs font-semibold text-violet-300 ring-1 ring-violet-500/30 transition hover:bg-violet-600/30 cursor-pointer">
                    <RotateCcw className="h-3 w-3" /> Join {lastRoomCode}
                  </button>
                )}
              </div>
            </div>

            {/* Hero 3D phones image — blended into dark background */}
            <div className="animate-fade-up-d3 relative mx-auto mt-12 max-w-4xl">
              <div className="animate-float-slow relative">
                {/* Dark blending layers around the white-bg image */}
                <div className="relative overflow-hidden rounded-3xl">
                  <img
                    src="/hero-phones.jpg"
                    alt="Two smartphones synced — YouTube Music and Spotify"
                    className="relative z-10 mx-auto block h-auto w-full max-w-3xl object-contain mix-blend-lighten"
                  />
                  {/* Edge fades to blend into dark bg */}
                  <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-t from-zinc-950 via-transparent to-zinc-950/80" />
                  <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-r from-zinc-950 via-transparent to-zinc-950" />
                  <div className="pointer-events-none absolute inset-0 z-20 rounded-3xl ring-1 ring-inset ring-white/5" />
                </div>
              </div>

              {/* Floating badges — above the image */}
              <div className="pointer-events-none absolute -top-2 -left-4 z-30 hidden lg:block">
                <div className="animate-float-gentle flex items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/80 px-3.5 py-2.5 shadow-xl backdrop-blur-lg">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                  <span className="text-xs font-bold text-white">YouTube Free</span>
                  <EqBars active colorClass="bg-red-500" />
                </div>
              </div>
              <div className="pointer-events-none absolute -top-4 -right-4 z-30 hidden lg:block">
                <div className="animate-float-reverse flex items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/80 px-3.5 py-2.5 shadow-xl backdrop-blur-lg">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-xs font-bold text-white">Spotify Premium</span>
                  <EqBars active colorClass="bg-emerald-500" />
                </div>
              </div>
              <div className="pointer-events-none absolute bottom-20 -left-6 z-30 hidden xl:block">
                <div className="animate-float-reverse flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/80 px-3.5 py-2 shadow-lg backdrop-blur-lg">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-pulse-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-xs font-semibold text-zinc-300">Synced • 14ms drift</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────── FEATURES ───────── */}
        <section id="features" ref={featRef} className="relative border-t border-white/5 py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className={`max-w-2xl ${featVis ? 'animate-fade-up' : 'opacity-0'}`}>
              <p className="text-xs font-bold tracking-widest text-violet-400 uppercase">How it works</p>
              <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-balance text-white sm:text-5xl">
                Start listening together in under 10 seconds.
              </h2>
            </div>

            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {FEATURES.map((f, i) => {
                const Icon = f.icon;
                return (
                  <div
                    key={f.title}
                    className={`group relative overflow-hidden rounded-3xl border border-white/5 bg-white/[0.02] p-7 transition-all duration-500 hover:-translate-y-1 hover:border-white/10 hover:bg-white/[0.04] ${featVis ? `animate-fade-up` : 'opacity-0'}`}
                    style={{ animationDelay: `${0.15 + i * 0.12}s` }}
                  >
                    {/* Glow */}
                    <div className={`absolute -top-20 -right-20 h-40 w-40 rounded-full bg-gradient-to-br ${f.gradient} opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-20`} />
                    <span className={`relative z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ${f.gradient} text-white shadow-lg`}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <h3 className="relative z-10 mt-5 font-display text-xl font-bold text-white">{f.title}</h3>
                    <p className="relative z-10 mt-2 text-sm leading-relaxed text-zinc-400">{f.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ───────── LIVE SYNC PLAYGROUND ───────── */}
        <section id="playground" ref={playRef} className="relative border-t border-white/5 py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className={`flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end ${playVis ? 'animate-fade-up' : 'opacity-0'}`}>
              <div>
                <p className="text-xs font-bold tracking-widest text-violet-400 uppercase">Interactive Demo</p>
                <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-balance text-white sm:text-5xl">
                  Test the sync right here.
                </h2>
                <p className="mt-2 text-sm text-zinc-400 sm:text-base">
                  Switch tracks, drag the host scrubber—watch both phones follow in lockstep.
                </p>
              </div>
              <button onClick={() => setDemoPlay((p) => !p)} className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white px-5 py-2.5 text-xs font-bold text-zinc-950 shadow-sm transition hover:bg-zinc-200 cursor-pointer">
                {demoPlay ? <><Pause className="h-3.5 w-3.5 fill-current" /> Pause Both</> : <><Play className="h-3.5 w-3.5 fill-current" /> Play Both</>}
              </button>
            </div>

            <div className={`mt-10 space-y-5 rounded-3xl border border-white/5 bg-white/[0.02] p-5 sm:p-7 ${playVis ? 'animate-fade-up-d2' : 'opacity-0'}`}>
              {/* Track pills */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  {[0, 1, 4].map((idx) => {
                    const t = INITIAL_TRACKS[idx];
                    const on = demoIdx === idx;
                    return (
                      <button key={t.id} onClick={() => { setDemoIdx(idx); setDemoTime(48); }}
                        className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${on ? 'bg-white text-zinc-950 shadow-xs' : 'bg-white/5 text-zinc-400 ring-1 ring-white/10 hover:bg-white/10 hover:text-white'}`}
                      >
                        <img src={t.coverImage} alt="" className="h-5 w-5 rounded object-cover" />
                        {t.title}
                      </button>
                    );
                  })}
                </div>
                <span className="font-mono text-xs font-semibold text-zinc-500">{demoPlay ? 'Synced • Live' : 'Paused'}</span>
              </div>

              {/* Visualizer canvas */}
              <div className="relative h-40 w-full overflow-hidden rounded-2xl border border-white/5 sm:h-52">
                <AudioVisualizerCanvas isPlaying={demoPlay} accentColor={demoTrack.accentColor} secondaryColor={demoTrack.secondaryColor} coverImage={demoTrack.coverImage} className="h-full w-full" />
                <div className="pointer-events-none absolute top-3 left-3 z-20 inline-flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur-md">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />Live Synced Stage
                </div>
                <div className="pointer-events-none absolute top-3 right-3 z-20 rounded-full bg-black/60 px-3 py-1 font-mono text-[11px] font-semibold text-white/80 backdrop-blur-md">
                  {formatTime(demoTime)} / {formatTime(demoTrack.durationSec)}
                </div>
              </div>

              {/* Two phone cards */}
              <div className="grid gap-5 md:grid-cols-2">
                {/* Host */}
                <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 transition hover:border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold tracking-widest text-zinc-500 uppercase">Host Phone</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-400">
                      <EqBars active={demoPlay} colorClass="bg-emerald-400" /> Spotify
                    </span>
                  </div>
                  <div className="mt-4 flex items-center gap-3.5">
                    <img src={demoTrack.coverImage} alt={demoTrack.title} className="h-12 w-12 shrink-0 rounded-xl object-cover shadow" />
                    <div>
                      <p className="text-sm font-bold text-white">{demoTrack.title}</p>
                      <p className="text-xs text-zinc-500">{demoTrack.artist}</p>
                    </div>
                  </div>
                  <div className="mt-4">
                    <div className="flex h-5 items-center">
                      <input type="range" min={0} max={demoTrack.durationSec} value={demoTime} onChange={(e) => setDemoTime(Number(e.target.value))} aria-label="Host scrubber"
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-white"
                        style={{ background: `linear-gradient(to right, #fff ${demoPct}%, #3f3f46 ${demoPct}%)` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[11px] font-semibold text-zinc-500">
                      <span>{formatTime(demoTime)}</span><span>{formatTime(demoTrack.durationSec)}</span>
                    </div>
                  </div>
                </div>
                {/* Guest */}
                <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 transition hover:border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold tracking-widest text-zinc-500 uppercase">Guest Phone</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-red-400">
                      <EqBars active={demoPlay} colorClass="bg-red-400" /> YouTube
                    </span>
                  </div>
                  <div className="mt-4 flex items-center gap-3.5">
                    <img src={demoTrack.coverImage} alt={demoTrack.title} className="h-12 w-12 shrink-0 rounded-xl object-cover shadow" />
                    <div>
                      <p className="text-sm font-bold text-white">{demoTrack.title}</p>
                      <p className="text-xs text-zinc-500">Auto-synced • 14ms drift</p>
                    </div>
                  </div>
                  <div className="mt-4">
                    <div className="flex h-5 items-center">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full bg-red-500 transition-all duration-300" style={{ width: `${demoPct}%` }} />
                      </div>
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[11px] font-semibold text-zinc-500">
                      <span>{formatTime(demoTime)}</span><span>{formatTime(demoTrack.durationSec)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────── LIFESTYLE / STORY ───────── */}
        <section id="story" ref={lifeRef} className="relative border-t border-white/5 py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className="grid items-center gap-10 lg:grid-cols-2">
              <div className={`${lifeVis ? 'animate-slide-left' : 'opacity-0'}`}>
                <p className="text-xs font-bold tracking-widest text-violet-400 uppercase">The story</p>
                <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-balance text-white sm:text-5xl">
                  Music was never meant to be listened to alone.
                </h2>
                <p className="mt-4 text-base leading-relaxed text-zinc-400">
                  You find a song that hits different. You send it to your friend and say "listen to this."
                  But you can't experience the drop together. By the time they play it, the moment is gone.
                </p>
                <p className="mt-3 text-base leading-relaxed text-zinc-400">
                  <span className="font-semibold text-white">Duet</span> fixes that. Create a room, share a code,
                  and press play. Both phones lock to the same second—whether one is on Spotify Premium
                  and the other on YouTube for free.
                </p>

                {/* Source pairing visual */}
                <div className="relative mt-8 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900">
                  <img src="/pairing-bridge.jpg" alt="Spotify vinyl disc and YouTube play prism connected by audio waves" className="relative mx-auto block h-40 w-full object-contain mix-blend-lighten sm:h-48" />
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-zinc-900 via-transparent to-zinc-900" />
                </div>
              </div>

              <div className={`${lifeVis ? 'animate-slide-right' : 'opacity-0'}`}>
                <div className="relative overflow-hidden rounded-3xl">
                  <img src="/lifestyle.jpg" alt="Two friends listening to music together on a couch" className="h-full w-full rounded-3xl object-cover shadow-2xl" />
                  <div className="absolute inset-0 rounded-3xl ring-1 ring-inset ring-white/10" />
                  {/* Overlay badge */}
                  <div className="absolute bottom-4 left-4 flex items-center gap-2.5 rounded-2xl bg-black/60 px-4 py-2.5 backdrop-blur-lg">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-pulse-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    </span>
                    <span className="text-xs font-bold text-white">Room K7M9P2 • In Sync</span>
                    <EqBars active colorClass="bg-emerald-400" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────── TRENDING / NOW PLAYING MARQUEE — Full Width ───────── */}
        <section className="border-t border-white/5 py-14 sm:py-20 overflow-hidden">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-bold tracking-widest text-violet-400 uppercase">Trending on Duet</p>
                <h2 className="mt-2 font-display text-2xl font-bold text-white sm:text-3xl">Most popular songs right now</h2>
              </div>
              <span className="hidden text-xs font-semibold text-zinc-600 sm:inline">Scroll for more →</span>
            </div>
          </div>

          {/* m9: scrollable row with side padding + arrow affordance (cards are
              no longer clipped at the viewport edges with no way to reach them) */}
          <div className="relative mt-8 px-5 sm:px-8">
            <div
              ref={trendingRef}
              className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{ scrollSnapType: 'x mandatory' }}
              aria-label="Trending songs — scroll to see more"
            >
              {trendingSongs.map((song, i) => (
                  <div
                    key={song.title}
                    onClick={() => onOpenDemo(resolveTrendingTrack(song, i))}
                    className="group relative w-44 shrink-0 cursor-pointer sm:w-52"
                    style={{ scrollSnapAlign: 'start' }}
                  >
                    <div className="relative overflow-hidden rounded-2xl">
                      <img src={song.img} alt={song.title} className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                      {/* Hover overlay */}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-all duration-300 group-hover:bg-black/40">
                        <Play className="h-10 w-10 fill-white text-white opacity-0 transition-all duration-300 group-hover:opacity-100 group-hover:scale-100 scale-75" />
                      </div>
                      {/* Trending badge */}
                      {song.hot && (
                        <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-orange-500/90 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                          🔥 Trending
                        </span>
                      )}
                    </div>
                    <div className="mt-2.5 px-0.5">
                      <p className="truncate text-sm font-bold text-white">{song.title}</p>
                      <p className="mt-0.5 truncate text-xs text-zinc-500">{song.artist}</p>
                    </div>
                  </div>
                ))}
            </div>
            {/* Edge fades */}
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-zinc-950 to-transparent sm:w-24" />
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-zinc-950 to-transparent sm:w-24" />
            <button
              onClick={() => scrollTrending(-1)}
              aria-label="Scroll trending songs left"
              className="absolute left-2 top-1/2 z-20 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-zinc-900/90 text-white shadow-lg transition hover:bg-zinc-800 sm:flex cursor-pointer"
            >
              ‹
            </button>
            <button
              onClick={() => scrollTrending(1)}
              aria-label="Scroll trending songs right"
              className="absolute right-2 top-1/2 z-20 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-zinc-900/90 text-white shadow-lg transition hover:bg-zinc-800 sm:flex cursor-pointer"
            >
              ›
            </button>
          </div>

        </section>

        {/* ───────── TECH DETAILS ───────── */}
        <section className="border-t border-white/5 py-20 sm:py-28">
          <div className="mx-auto max-w-5xl px-5 sm:px-8">
            <p className="text-xs font-bold tracking-widest text-violet-400 uppercase">Under the hood</p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-balance text-white sm:text-4xl">
              Built for real phones, not just desktop tabs.
            </h2>

            <div className="mt-10 divide-y divide-white/5 border-t border-b border-white/5">
              {[
                { icon: Sparkles, title: 'Clock-compensated sync', text: 'Each transport event carries a server timestamp and round-trip offset. Drift under 350ms stays smooth; larger drift snaps right back.' },
                { icon: Volume2, title: 'Mobile autoplay unlock', text: 'iOS Safari and Android Chrome block unmuted playback without a tap. One "Tap to Join Audio" action unlocks and snaps to the host\'s second.' },
                { icon: Smartphone, title: 'One-tap resync', text: 'If drift ever creeps in, one tap on Resync re-measures the clock offset and snaps both phones back together — no manual offset needed.' },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="group grid gap-4 py-7 sm:grid-cols-12 sm:items-center">
                    <div className="flex items-center gap-3 sm:col-span-4">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5 text-white ring-1 ring-white/10 transition group-hover:bg-white/10">
                        <Icon className="h-4 w-4" />
                      </span>
                      <h3 className="font-display text-lg font-bold text-white">{item.title}</h3>
                    </div>
                    <p className="text-sm leading-relaxed text-zinc-400 sm:col-span-8">{item.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ───────── FAQ ───────── */}
        <section id="faq" ref={faqRef} className="border-t border-white/5 py-20 sm:py-28">
          <div className="mx-auto max-w-3xl px-5 sm:px-8">
            <div className={`${faqVis ? 'animate-fade-up' : 'opacity-0'}`}>
              <p className="text-xs font-bold tracking-widest text-violet-400 uppercase">FAQ</p>
              <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Common questions
              </h2>
            </div>
            <div className={`mt-8 space-y-3 ${faqVis ? 'animate-fade-up-d1' : 'opacity-0'}`}>
              {FAQS.map((item, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div key={item.q} className="rounded-2xl border border-white/5 bg-white/[0.02] transition hover:border-white/10">
                    <button onClick={() => setOpenFaq(isOpen ? -1 : idx)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left cursor-pointer">
                      <span className="text-sm font-bold text-white sm:text-base">{item.q}</span>
                      <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isOpen && <div className="px-5 pb-4 text-sm leading-relaxed text-zinc-400">{item.a}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ───────── CTA BANNER ───────── */}
        <section className="relative overflow-hidden border-t border-white/5">
          <div className="absolute inset-0"><img src="/dark-bg.jpg" alt="" className="h-full w-full object-cover opacity-30" /></div>
          <div className="relative z-10 mx-auto max-w-4xl px-5 py-20 text-center sm:py-28">
            <h2 className="font-display text-3xl font-bold text-white sm:text-5xl">Ready to press play?</h2>
            <p className="mx-auto mt-4 max-w-md text-base text-zinc-400">Create a room in one tap. Share a code. Listen to the same song at the same second.</p>
            <button onClick={() => onCreateRoom(connectedSource)} disabled={roomLoading} className="mt-8 inline-flex items-center gap-2.5 rounded-full bg-white px-8 py-4 text-sm font-bold text-zinc-950 shadow-lg shadow-violet-600/15 transition-all hover:-translate-y-0.5 hover:shadow-xl active:translate-y-0 disabled:opacity-50 cursor-pointer">
              <Play className="h-4 w-4 fill-current" />
              {roomLoading ? 'Creating your room…' : 'Create a Room — Free'}
            </button>
          </div>
        </section>
      </main>

      {/* ───────── FOOTER ───────── */}
      <footer className="border-t border-white/5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 text-xs text-zinc-600 sm:flex-row sm:px-8">
          <div className="flex items-center gap-2 font-semibold text-white">
            <Headphones className="h-3.5 w-3.5" /> Duet
          </div>
          <div className="flex items-center gap-4">
            <p>Synchronized YouTube + Spotify listening rooms.</p>
            <button
              onClick={() => {
                const el = document.getElementById('duet-privacy-modal');
                if (el) el.showModal();
              }}
              className="font-semibold text-zinc-400 underline decoration-zinc-700 underline-offset-2 transition hover:text-white cursor-pointer"
            >
              Privacy
            </button>
          </div>
        </div>
      </footer>

      {/* Footer privacy dialog */}
      <dialog id="duet-privacy-modal" className="m-auto max-w-sm rounded-3xl border border-white/10 bg-zinc-900 p-6 text-white backdrop:bg-black/60 backdrop:backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600/20 text-emerald-400">
            <Sparkles className="h-5 w-5" />
          </div>
          <h3 className="font-display text-lg font-bold text-white">Privacy & Data</h3>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-zinc-400">
          <p><strong className="text-white">Rooms are ephemeral.</strong> When a room closes, all data — messages, queue, and session info — is permanently deleted.</p>
          <p><strong className="text-white">No accounts required.</strong> No persistent user data is stored.</p>
          <p><strong className="text-white">No tracking.</strong> Duet does not use cookies, analytics, or advertising trackers.</p>
        </div>
        <form method="dialog" className="mt-5">
          <button className="w-full rounded-full bg-white/10 py-2.5 text-xs font-semibold text-white hover:bg-white/15 cursor-pointer">Got it</button>
        </form>
      </dialog>
    </div>
  );
}
