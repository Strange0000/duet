import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ChevronDown, Github, Headphones, Instagram, Linkedin, Link2, Moon, Phone,
  Pause, Play, Radio, RotateCcw, Sun, Users, Youtube,
} from 'lucide-react';
import { INITIAL_TRACKS, SEARCH_CATALOG, formatTime } from '../data/mockTracks';
import { fetchSongArtwork } from '../utils/artworkApi';
import { canUseSpotify, getStoredSpotifyAuth } from '../utils/spotifyAuth';
import SpotifyConnectModal from './SpotifyConnectModal';
import { getGlassAppearance, HOME_THEME_KEY } from '../utils/appearance';
import heroArtwork from '../assets/duet-headphones.webp';
import heroArtworkSmall from '../assets/duet-headphones-small.webp';
import heroArtworkFallback from '../assets/duet-headphones-fallback.jpg?inline';
import './LandingPage.css';

const DEMO_TRACKS = [0, 1, 4];
const CREATOR_LINKS = [
  { label: 'Instagram', href: 'https://www.instagram.com/sumit_jaiswal__', icon: Instagram },
  { label: 'Portfolio', href: 'https://strange0000.github.io/portfolio/', icon: Link2 },
  { label: 'GitHub', href: 'https://github.com/Strange0000', icon: Github },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/sumit-jaiswal-6a3831347', icon: Linkedin },
];

const STEPS = [
  { icon: Users, title: 'Create a room', body: 'Start a private listening room in your browser.' },
  { icon: Link2, title: 'Share the invite', body: 'Send your partner a link or a six-character room code.' },
  { icon: Headphones, title: 'Press play together', body: 'Play, pause, and skip from the same queue while Duet keeps you in sync.' },
];

const FAQS = [
  {
    q: 'Does my friend need Spotify Premium?',
    a: 'Your friend can use YouTube for free. For Audio Only, you need your own Spotify developer app (Client ID) and each Spotify listener needs Premium.',
  },
  {
    q: 'Does Duet work on iPhone and Android?',
    a: 'YouTube works in iOS Safari and Android Chrome. Spotify Audio Only is supported on desktop and Android Chrome.',
  },
  {
    q: 'What if playback drifts?',
    a: 'Duet uses the host’s playback position to keep listeners together. Select Resync in the room if you need to catch up.',
  },
  {
    q: 'Why do guests see “Tap to Join Audio”?',
    a: 'Mobile browsers require a tap before playing sound. It lets Duet start audio at the host’s current position.',
  },
];

const TRENDING_SONGS = [
  { img: '/cover-midnight.jpg', title: 'Midnight City', artist: 'M83' },
  { img: '/cover-instant.jpg', title: 'Instant Crush', artist: 'Daft Punk' },
  { img: '/cover-resonance.jpg', title: 'Resonance', artist: 'HOME' },
  { img: '/cover-synth.jpg', title: 'Blinding Lights', artist: 'The Weeknd' },
  { img: 'https://i.ytimg.com/vi/nxuzYWcY2O0/hqdefault.jpg', title: 'Redbone', artist: 'Childish Gambino' },
  { img: '/cover-indie.jpg', title: 'The Less I Know The Better', artist: 'Tame Impala' },
  { img: '/cover-synth.jpg', title: 'Starboy', artist: 'The Weeknd' },
  { img: '/cover-instant.jpg', title: 'After Dark', artist: 'Mr.Kitty' },
  { img: '/cover-indie.jpg', title: 'Dreams', artist: 'Fleetwood Mac' },
  { img: '/cover-soul.jpg', title: 'Sweater Weather', artist: 'The Neighbourhood' },
];

/* m5: turn a bare server/join error into a friendly message with a next step. */
function friendlyRoomError(err) {
  if (!err) return '';
  const text = String(err);
  if (/not found|expired|ROOM_NOT_FOUND/i.test(text)) {
    return 'Room not found or expired. Check the code, ask the host for a new link, or start your own room.';
  }
  if (/Request timed out \(room:(create|join)\)/i.test(text)) {
    return 'Duet couldn’t reach the room server in time. Check your connection and try again.';
  }
  if (/full|ROOM_FULL/i.test(text)) {
    // The server error carries the real limit ("maximum 6 participants");
    // use it so this message stays correct if the limit changes again.
    const limit = text.match(/maximum (\d+) participants/i)?.[1] || '6';
    return `That room is already full (${limit} people max). Ask the host for a new link, or start your own room.`;
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

function SyncPlayground({ onOpenDemo }) {
  const [trackIndex, setTrackIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(102);
  const track = INITIAL_TRACKS[trackIndex];
  const progress = `${Math.min(100, elapsed / track.durationSec * 100)}%`;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setElapsed((value) => (value + 1) % track.durationSec), 1000);
    return () => clearInterval(timer);
  }, [playing, track.durationSec]);

  return (
    <section id="playground" className="home-section home-shell">
      <div className="home-section-intro">
        <div>
          <h2>Try the sync.</h2>
          <p>Move the host’s playhead and watch the guest follow. This interactive preview runs without audio.</p>
        </div>
        <button type="button" className="home-link" onClick={() => onOpenDemo(track)}>
          Open demo room <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="home-demo">
        <div className="home-demo-record">
          <img src={track.coverImage} alt="" loading="lazy" width="200" height="200" />
          <div className="home-demo-track">
            <h3>{track.title}</h3>
            <p>{track.artist}</p>
          </div>
          <button
            type="button"
            className="home-demo-play"
            aria-label={playing ? 'Pause both players' : 'Play both players'}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
        </div>
        <div className="home-demo-timelines" style={{ '--demo-progress': progress }}>
          <div className="home-demo-time">
            <label htmlFor="home-demo-position">Host</label>
            <span>{formatTime(elapsed)} / {formatTime(track.durationSec)}</span>
          </div>
          <input
            id="home-demo-position"
            type="range"
            min="0"
            max={track.durationSec}
            value={elapsed}
            aria-label="Host scrubber"
            onChange={(event) => setElapsed(Number(event.target.value))}
          />
          <div className="home-demo-time">
            <span>Guest</span>
            <span>{formatTime(elapsed)} / {formatTime(track.durationSec)}</span>
          </div>
          <div className="home-demo-follow" aria-hidden="true"><span /></div>
          <div className="home-demo-options" aria-label="Demo tracks" role="group">
            {DEMO_TRACKS.map((index) => (
              <button
                type="button"
                key={index}
                aria-pressed={trackIndex === index}
                onClick={() => {
                  setTrackIndex(index);
                  setElapsed(0);
                }}
              >
                {INITIAL_TRACKS[index].title}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function DemoTrackShelf({ onOpenDemo }) {
  const [songs, setSongs] = useState(TRENDING_SONGS);
  const shelfRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(TRENDING_SONGS.map(async (song) => {
      const image = await fetchSongArtwork(song.title, song.artist);
      return image ? { ...song, img: image } : song;
    })).then((updated) => {
      if (!cancelled) setSongs(updated);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="home-section home-shell" aria-labelledby="home-demo-tracks">
      <div className="home-section-intro">
        <div>
          <h2 id="home-demo-tracks">Pick a demo track.</h2>
          <p>Open a demo room with a song from the sample queue.</p>
        </div>
        <div className="home-shelf-controls">
          {[-1, 1].map((direction) => (
            <button
              type="button"
              key={direction}
              className="home-icon-button"
              aria-label={direction < 0 ? 'Scroll tracks left' : 'Scroll tracks right'}
              onClick={() => {
                const shelf = shelfRef.current;
                shelf?.scrollBy({ left: direction * shelf.clientWidth * 0.8 });
              }}
            >
              {direction < 0 ? <ArrowLeft size={18} /> : <ArrowRight size={18} />}
            </button>
          ))}
        </div>
      </div>
      <div className="home-shelf" ref={shelfRef}>
        {songs.map((song, index) => (
          <button
            type="button"
            className="home-shelf-track"
            key={song.title}
            onClick={() => onOpenDemo(resolveTrendingTrack(song, index))}
          >
            <span className="home-shelf-cover">
              <img
                src={song.img}
                alt=""
                width="220"
                height="220"
                loading="lazy"
                onError={(event) => {
                  const image = event.currentTarget;
                  if (!image.src.endsWith('/cover-soul.jpg')) image.src = '/cover-soul.jpg';
                }}
              />
              <span aria-hidden="true"><Play size={16} fill="currentColor" /></span>
            </span>
            <strong>{song.title}</strong>
            <span>{song.artist}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function LandingPage({
  onCreateRoom,
  onJoinRoom,
  onOpenDemo,
  lastRoomCode,
  roomLoading,
  roomError,
  pendingApproval,
  homeTheme,
  setHomeTheme,
}) {
  const [joinCode, setJoinCode] = useState('');
  const [joinErr, setJoinErr] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [spotifyModalOpen, setSpotifyModalOpen] = useState(false);
  const [connectedSource, setConnectedSource] = useState(() => canUseSpotify() ? 'spotify' : 'youtube');
  const [spotifyAuth, setSpotifyAuth] = useState(getStoredSpotifyAuth);
  const connectButtonRef = useRef(null);
  const nextTheme = homeTheme === 'light' ? 'dark' : 'light';

  useEffect(() => {
    if (!connectOpen) return;
    const closeOutside = (event) => {
      if (!event.target.closest('[data-connect-dropdown]')) setConnectOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setConnectOpen(false);
      connectButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [connectOpen]);

  const toggleHomeTheme = () => {
    setHomeTheme(nextTheme);
    try {
      localStorage.setItem(HOME_THEME_KEY, nextTheme);
    } catch {
      // The toggle remains usable without storage.
    }
  };

  const selectSource = (source) => {
    setConnectOpen(false);
    if (source === 'spotify' && !canUseSpotify(spotifyAuth)) {
      setSpotifyModalOpen(true);
    } else {
      setConnectedSource(source);
      connectButtonRef.current?.focus();
    }
  };

  const handleJoin = (event) => {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      setJoinErr('Enter the six-character room code.');
      return;
    }
    setJoinErr('');
    onJoinRoom(code, connectedSource);
  };

  const createRoom = () => onCreateRoom(connectedSource);
  const [glass] = useState(getGlassAppearance);
  const [heroImageFailed, setHeroImageFailed] = useState(false);

  return (
    <div className="duet-home" data-theme={homeTheme} data-glass={glass ? 'on' : 'off'} id="home">
      <SpotifyConnectModal
        open={spotifyModalOpen}
        onClose={() => { setSpotifyModalOpen(false); connectButtonRef.current?.focus(); }}
        onConnected={() => {
          setSpotifyAuth(getStoredSpotifyAuth());
          setConnectedSource('spotify');
        }}
        onDisconnected={() => {
          setSpotifyAuth(null);
          if (connectedSource === 'spotify') setConnectedSource('youtube');
        }}
      />

      <header className="home-header">
        <div className="home-shell home-header-inner">
          <a href="#home" className="home-brand" aria-label="Duet home"><Radio size={20} aria-hidden="true" />Duet</a>
          <nav className="home-nav" aria-label="Main navigation">
            <a href="#features">How it works</a>
            <a href="#playground">Try the demo</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="home-header-actions">
            <button type="button" className="home-icon-button" onClick={toggleHomeTheme} aria-label={`Switch to ${nextTheme} mode`} title={`Switch to ${nextTheme} mode`}>
              {homeTheme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
            </button>
            <div className="home-source" data-connect-dropdown>
              <button
                type="button"
                ref={connectButtonRef}
                className="home-source-button"
                aria-expanded={connectOpen}
                aria-controls="home-source-options"
                onClick={() => setConnectOpen((open) => !open)}
              >
                {connectedSource === 'youtube' ? <Youtube size={16} aria-hidden="true" /> : <Headphones size={16} aria-hidden="true" />}
                {connectedSource === 'youtube' ? 'YouTube' : 'Audio Only'}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {connectOpen && (
                <div className="home-source-dropdown" id="home-source-options" role="group" aria-label="Playback source">
                  <button type="button" aria-pressed={connectedSource === 'youtube'} onClick={() => selectSource('youtube')}>
                    <Youtube size={20} aria-hidden="true" /><span><strong>YouTube</strong><small>Free with video</small></span>
                  </button>
                  <button type="button" aria-pressed={connectedSource === 'spotify'} onClick={() => selectSource('spotify')}>
                    <Headphones size={20} aria-hidden="true" /><span><strong>{canUseSpotify(spotifyAuth) ? 'Audio Only' : spotifyAuth?.accessToken ? 'Manage Spotify' : 'Set up Spotify'}</strong><small>{canUseSpotify(spotifyAuth) ? 'Spotify Premium' : 'Premium required'}</small></span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main>
        <section className="home-hero home-shell" aria-labelledby="home-headline">
          <div className="home-hero-copy">
            <div className="home-hero-intro">
              <h1 id="home-headline">One song.<br /><span>Same second.</span></h1>
              <p className="home-hero-lead">Create a listening room, share the invite, and hear the same song together, wherever you are.</p>
            </div>
            <div className="home-hero-controls">
              <div className="home-hero-actions">
                <button type="button" className="home-primary" onClick={createRoom} disabled={roomLoading}>
                  {roomLoading ? 'Creating your room…' : 'Create a Room'} <ArrowRight size={17} aria-hidden="true" />
                </button>
                <button type="button" className="home-link" onClick={() => onOpenDemo()}>
                  <Play size={16} aria-hidden="true" /> Try the demo
                </button>
              </div>
              <form className="home-join" onSubmit={handleJoin}>
                <label htmlFor="home-room-code">Have a room code?</label>
                <div>
                  <input
                    id="home-room-code"
                    type="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    maxLength={8}
                    value={joinCode}
                    onChange={(event) => { setJoinCode(event.target.value.toUpperCase()); setJoinErr(''); }}
                    aria-label="Room code"
                    placeholder="Enter room code"
                  />
                  <button type="submit" disabled={roomLoading}>Join <ArrowRight size={15} aria-hidden="true" /></button>
                </div>
              </form>
              {(joinErr || roomError) && <p className="home-form-error" role="alert">{joinErr || friendlyRoomError(roomError)}</p>}
              {pendingApproval && <p className="home-room-status" role="status">Waiting for host approval to join {pendingApproval.roomCode}…</p>}
              {lastRoomCode && (
                <button type="button" className="home-link home-rejoin" onClick={() => onJoinRoom(lastRoomCode, connectedSource)} disabled={roomLoading}>
                  <RotateCcw size={14} aria-hidden="true" /> Rejoin {lastRoomCode}
                </button>
              )}
            </div>
          </div>
          <figure className="home-hero-art">
            <img
              src={heroImageFailed ? heroArtworkFallback : heroArtwork}
              srcSet={heroImageFailed ? undefined : `${heroArtworkSmall} 640w, ${heroArtwork} 1320w`}
              onError={heroImageFailed ? undefined : () => setHeroImageFailed(true)}
              sizes="(max-width: 899px) 94vw, 55vw"
              width="1320"
              height="990"
              fetchPriority="high"
              alt="Lavender and plum headphones on a smoked violet surface"
            />
            <div className="home-hero-spectrum" aria-hidden="true">
              {[22, 38, 53, 29, 66, 44, 77, 48, 33, 58, 40, 23].map((height, index) => (
                <i key={index} style={{ '--bar-height': `${height}%`, '--bar-delay': `${index * -90}ms` }} />
              ))}
            </div>
          </figure>
        </section>

        <section id="features" className="home-section home-shell">
          <div className="home-section-intro"><h2>From invite to play.</h2></div>
          <div className="home-steps">
            {STEPS.map(({ icon: Icon, title, body }) => (
              <div key={title}>
                <Icon size={22} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>

        <SyncPlayground onOpenDemo={onOpenDemo} />

        <section className="home-section home-shell home-story" id="story">
          <div className="home-story-art">
            <img
              src="/home/listening-together.webp"
              srcSet="/home/listening-together-small.webp 640w, /home/listening-together.webp 1320w"
              sizes="(max-width: 899px) 94vw, 52vw"
              width="1320"
              height="880"
              loading="lazy"
              alt="Two friends relaxing on a sofa while listening with headphones"
            />
          </div>
          <div className="home-story-copy">
            <h2>Hear the drop together.</h2>
            <p>Queue up the tracks you keep coming back to and chat while you listen. When a friend joins, Duet catches them up to the host’s spot in the song.</p>
            <p><strong>Pick your playback source.</strong> Use YouTube for free. Spotify Audio Only requires your own Spotify developer app (Client ID) and a Premium account for each Spotify listener.</p>
          </div>
        </section>

        <DemoTrackShelf onOpenDemo={onOpenDemo} />

        <section id="faq" className="home-section home-shell home-faq">
          <h2>Common questions.</h2>
          <div>
            {FAQS.map(({ q, a }) => (
              <details key={q}>
                <summary>{q}<ChevronDown size={18} aria-hidden="true" /></summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="home-shell home-close">
          <div>
            <h2>Ready to press play?</h2>
            <button type="button" className="home-primary" onClick={createRoom} disabled={roomLoading}>
              {roomLoading ? 'Creating your room…' : 'Create a Room'} <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>

      <footer className="home-shell home-footer">
        <div className="home-footer-contact">
          <a href="#home" className="home-brand" aria-label="Duet home"><Radio size={18} aria-hidden="true" />Duet</a>
          <p>Built by <strong>Sumit Jaiswal (Strange)</strong></p>
          <a className="home-link" href="tel:+917005319072"><Phone size={17} aria-hidden="true" />7005319072</a>
        </div>
        <div>
          <h2>Find me online</h2>
          <ul className="home-footer-socials">
            {CREATOR_LINKS.map(({ label, href, icon: Icon }) => (
              <li key={label}><a className="home-link" href={href}><Icon size={17} aria-hidden="true" />{label}</a></li>
            ))}
          </ul>
        <button
          type="button"
          className="home-link"
          onClick={() => document.getElementById('duet-privacy-modal')?.showModal()}
        >
          Privacy & Data
        </button>
        </div>
      </footer>

      <dialog id="duet-privacy-modal" className="home-privacy" aria-labelledby="home-privacy-heading">
        <h2 id="home-privacy-heading">Privacy & Data</h2>
        <p>Rooms are temporary. Messages, queue entries, and session information are deleted when a room closes.</p>
        <p>Duet rooms don’t require an account. Spotify sign-in is required for Audio Only.</p>
        <form method="dialog"><button className="home-primary">Got it</button></form>
      </dialog>
    </div>
  );
}
