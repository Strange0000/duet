const artworkCache = new Map();

/**
 * Fetches real 600x600 album artwork and track metadata from the free iTunes Search API
 * (no API key required). Falls back gracefully if offline or not found.
 */
export async function fetchSongArtwork(title, artist = '') {
  const key = `${title}::${artist}`.toLowerCase();
  if (artworkCache.has(key)) {
    return artworkCache.get(key);
  }

  try {
    const query = encodeURIComponent(`${title} ${artist}`.trim());
    const res = await fetch(
      `https://itunes.apple.com/search?term=${query}&media=music&entity=song&limit=1`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.results?.[0];
    if (!item?.artworkUrl100) return null;

    const hiRes = item.artworkUrl100.replace('100x100bb', '600x600bb');
    artworkCache.set(key, hiRes);
    return hiRes;
  } catch {
    return null;
  }
}

/**
 * Searches real songs via the free iTunes Search API (no API key required).
 */
export async function searchRealSongs(query, limit = 8) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        trimmed
      )}&media=music&entity=song&limit=${limit}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.results || []).map((item) => ({
      id: `itunes-${item.trackId}`,
      title: item.trackName,
      artist: item.artistName,
      album: item.collectionName || 'Single',
      durationSec: item.trackTimeMillis > 0 ? Math.max(1, Math.round(item.trackTimeMillis / 1000)) : null,
      coverImage: item.artworkUrl100
        ? item.artworkUrl100.replace('100x100bb', '600x600bb')
        : null,
      coverGradient: 'from-violet-600 via-fuchsia-500 to-orange-400',
      accentColor: '#7c3aed',
      secondaryColor: '#f43f5e',
      // N-01: never fabricate playable IDs. iTunes gives no YouTube/Spotify
      // IDs, so these stay null until resolveYouTubeTrack() finds a real one.
      youtubeId: null,
      spotifyUri: null,
    }));
  } catch {
    return [];
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Resolve a title/artist to a real, playable YouTube video via the backend
 * (GET /api/youtube/resolve). Returns { item | null, configured } where item
 * has a real youtubeId + durationSec when the YouTube API key is configured.
 * Returns null on network/HTTP failure.
 */
export async function resolveYouTubeTrack(title, artist = '') {
  try {
    const res = await fetch(
      `${API_URL}/api/youtube/resolve?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
