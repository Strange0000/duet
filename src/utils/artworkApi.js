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
      durationSec: Math.max(30, Math.round((item.trackTimeMillis || 210000) / 1000)),
      coverImage: item.artworkUrl100
        ? item.artworkUrl100.replace('100x100bb', '600x600bb')
        : null,
      coverGradient: 'from-violet-600 via-fuchsia-500 to-orange-400',
      accentColor: '#7c3aed',
      secondaryColor: '#f43f5e',
      youtubeId: `yt_${item.trackId}`,
      spotifyUri: `spotify:track:${item.trackId}`,
      ytOffsetMs: 0,
    }));
  } catch {
    return [];
  }
}
