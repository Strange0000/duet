// Round 5: durationSec is the TRUE YouTube video length (verified against
// the YouTube Data API 2026-11-28), NOT the song length. The old values
// were song lengths, so the player's real-duration correction overwrote
// them after every play and the queue looked corrupted (Instant Crush
// 05:37 → 05:40, The Less I Know The Better 03:36 → 05:43 — the videos
// really are 340s and 343s long). Midnight City 244, Instant Crush 340,
// The Less I Know The Better 343, Starboy 274, Resonance 213.
export const INITIAL_TRACKS = [
  {
    id: 'trk-1',
    title: 'Midnight City',
    artist: 'M83',
    album: "Hurry Up, We're Dreaming",
    durationSec: 244,
    coverImage: '/cover-midnight.jpg',
    coverGradient: 'from-violet-600 via-fuchsia-500 to-orange-400',
    accentColor: '#7c3aed',
    secondaryColor: '#f97316',
    youtubeId: 'dX3k_QDnzHE',
    spotifyUri: 'spotify:track:1eyzqe2QqGZUmfcPZtrIyt',
  },
  {
    id: 'trk-2',
    title: 'Instant Crush',
    artist: 'Daft Punk ft. Julian Casablancas',
    album: 'Random Access Memories',
    durationSec: 340,
    coverImage: '/cover-instant.jpg',
    coverGradient: 'from-slate-900 via-indigo-800 to-cyan-500',
    accentColor: '#4f46e5',
    secondaryColor: '#06b6d4',
    youtubeId: 'a5uQMwRMHcs',
    spotifyUri: 'spotify:track:2cGxRwrMyEAp8dEbuZaVv6',
  },
  {
    id: 'trk-3',
    title: 'The Less I Know The Better',
    artist: 'Tame Impala',
    album: 'Currents',
    durationSec: 343,
    coverImage: '/cover-indie.jpg',
    coverGradient: 'from-rose-500 via-purple-600 to-indigo-700',
    accentColor: '#e11d48',
    secondaryColor: '#7c3aed',
    youtubeId: 'sBzrzS1Ag_g',
    spotifyUri: 'spotify:track:6K4t31amVTZDgR3sKmwUJJ',
  },
  {
    id: 'trk-4',
    title: 'Starboy',
    artist: 'The Weeknd ft. Daft Punk',
    album: 'Starboy',
    durationSec: 274,
    coverImage: '/cover-synth.jpg',
    coverGradient: 'from-red-600 via-rose-600 to-amber-500',
    accentColor: '#dc2626',
    secondaryColor: '#f59e0b',
    youtubeId: '34Na4j8AVgA',
    spotifyUri: 'spotify:track:7MXVkk9YMctZqd1Srtv4MB',
  },
  {
    id: 'trk-5',
    title: 'Resonance',
    artist: 'HOME',
    album: 'Odyssey',
    durationSec: 213,
    coverImage: '/cover-resonance.jpg',
    coverGradient: 'from-amber-400 via-orange-500 to-pink-600',
    accentColor: '#ea580c',
    secondaryColor: '#ec4899',
    youtubeId: '8GW6sLrK40k',
    spotifyUri: 'spotify:track:1TuopWDIuDi1553081zvuU',
  },
];

export const SEARCH_CATALOG = [
  ...INITIAL_TRACKS,
  {
    id: 'trk-6',
    title: 'After Dark',
    artist: 'Mr.Kitty',
    album: 'Time',
    durationSec: 257,
    coverGradient: 'from-zinc-900 via-violet-900 to-fuchsia-700',
    accentColor: '#6d28d9',
    youtubeId: 'sVx1mJDeUjY',
    spotifyUri: 'spotify:track:2LKOHdMsL0K9KwcPRlJK2v',
  },
  {
    id: 'trk-7',
    title: 'Redbone',
    artist: 'Childish Gambino',
    album: 'Awaken, My Love!',
    durationSec: 326,
    coverGradient: 'from-sky-500 via-blue-700 to-indigo-950',
    accentColor: '#0284c7',
    youtubeId: 'Kp7eSUU9oy8',
    spotifyUri: 'spotify:track:0wXuerDYiBnERgIpbb3JBR',
  },
  {
    id: 'trk-8',
    title: 'Dreams',
    artist: 'Fleetwood Mac',
    album: 'Rumours',
    durationSec: 257,
    coverGradient: 'from-emerald-500 via-teal-600 to-cyan-700',
    accentColor: '#0d9488',
    youtubeId: 'mrZRURcb1cM',
    spotifyUri: 'spotify:track:0ofHAoxe9vBkTCp2UQIavz',
  },
];

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

