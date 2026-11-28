import { env } from '../config/env.js';

const searchCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SEARCH_CACHE_ENTRIES = 200;

// YouTube Data API v3 quota guard (N-31): in-memory count of YouTube Data API
// calls per calendar day. The default free quota is 10,000 units/day; we stop
// at 9,000 to leave headroom. Resets at midnight (local server date).
const YOUTUBE_QUOTA_DAILY_LIMIT = 9000;
let youtubeQuotaDay = null;
let youtubeQuotaCount = 0;

function youtubeQuotaDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function consumeYouTubeQuota(units = 1) {
  const today = youtubeQuotaDayKey();
  if (youtubeQuotaDay !== today) {
    youtubeQuotaDay = today;
    youtubeQuotaCount = 0;
  }
  if (youtubeQuotaCount + units > YOUTUBE_QUOTA_DAILY_LIMIT) return false;
  youtubeQuotaCount += units;
  return true;
}

export function getYouTubeQuotaUsage() {
  const today = youtubeQuotaDayKey();
  if (youtubeQuotaDay !== today) return { day: today, count: 0, limit: YOUTUBE_QUOTA_DAILY_LIMIT };
  return { day: youtubeQuotaDay, count: youtubeQuotaCount, limit: YOUTUBE_QUOTA_DAILY_LIMIT };
}

// Test-only hook: lets tests simulate a nearly-exhausted quota without
// making 9,000 real API calls.
export function __setYouTubeQuotaForTest(count) {
  youtubeQuotaDay = youtubeQuotaDayKey();
  youtubeQuotaCount = count;
}

export function parseIsoDurationToSec(iso) {
  // Handles days (P1DT2H3M4S), plain days (P1D) and fractional seconds (PT1M30.5S).
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso || '');
  if (!match) return 0;
  const d = Number(match[1] || 0);
  const h = Number(match[2] || 0);
  const m = Number(match[3] || 0);
  const s = Number(match[4] || 0);
  return d * 86400 + h * 3600 + m * 60 + s;
}

function isBadVariantTitle(title) {
  return /\b(karaoke|cover|nightcore|slowed|reverb|sped up|8d audio|instrumental)\b/i.test(title);
}

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\(official.*?\)|\[official.*?\]/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isYouTubeHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  // Exact host matching (N-27): the host must be youtube.com / youtu.be or a
  // subdomain of one of them. `notyoutube.com` and `evil-youtu.be` fail both
  // checks because they do not equal the bare domain and do not end with
  // ".youtube.com" / ".youtu.be".
  return (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtu.be' ||
    host.endsWith('.youtu.be')
  );
}

function isShortHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'youtu.be' || host.endsWith('.youtu.be');
}

export function extractYouTubeId(input) {
  const trimmed = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!isYouTubeHost(url.hostname)) return null;
    if (isShortHost(url.hostname)) {
      const id = url.pathname.replace(/^\//, '').slice(0, 11);
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'shorts' || p === 'embed' || p === 'live');
    if (idx !== -1 && parts[idx + 1] && /^[A-Za-z0-9_-]{11}$/.test(parts[idx + 1])) {
      return parts[idx + 1];
    }
  } catch {
    // Not a URL
  }
  return null;
}

export function scoreYouTubeCandidate(video, targetTitle, targetArtist = '', targetDurationSec = 0) {
  const vTitle = normalizeText(video.title);
  const vArtist = normalizeText(video.artist);
  const qTitle = normalizeText(targetTitle);
  const qArtist = normalizeText(targetArtist);

  let score = 0;
  if (qTitle && vTitle.includes(qTitle)) score += 45;
  if (qArtist && (vArtist.includes(qArtist) || vTitle.includes(qArtist))) score += 25;
  if (/official audio|official music video|topic/i.test(`${video.title} ${video.rawChannel || ''}`)) {
    score += 15;
  }
  if (targetDurationSec > 0 && video.durationSec > 0) {
    const diff = Math.abs(video.durationSec - targetDurationSec);
    if (diff <= 5) score += 15;
    else if (diff <= 15) score += 8;
    else if (diff > 45) score -= 20;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * Lookup a specific YouTube video ID via YouTube Data API v3 (if configured)
 * or official YouTube oEmbed endpoint (no API key required).
 */
export async function lookupYouTubeVideo(videoId) {
  const id = extractYouTubeId(videoId);
  if (!id) {
    return { error: 'Invalid YouTube URL or video ID' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    if (env.YOUTUBE_API_KEY) {
      if (!consumeYouTubeQuota(1)) {
        return { error: 'YouTube search quota exhausted for today' };
      }
      const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      detailsUrl.searchParams.set('part', 'snippet,contentDetails,status');
      detailsUrl.searchParams.set('id', id);
      detailsUrl.searchParams.set('key', env.YOUTUBE_API_KEY);

      const res = await fetch(detailsUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
      const data = await res.json();
      const v = data.items?.[0];
      if (!v) return { error: 'Video not found or private' };
      if (v.status?.embeddable === false) {
        return { error: 'Embedding is disabled for this video by its owner' };
      }

      return {
        item: {
          id: `yt-${v.id}`,
          title: v.snippet?.title || 'Untitled',
          artist: v.snippet?.channelTitle?.replace(/\s*-\s*Topic$/i, '') || 'YouTube',
          album: 'YouTube',
          durationSec: Math.max(15, parseIsoDurationToSec(v.contentDetails?.duration)),
          coverImage:
            v.snippet?.thumbnails?.high?.url ||
            v.snippet?.thumbnails?.medium?.url ||
            `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          youtubeId: v.id,
          sourceAttribution: 'YouTube',
          attributionUrl: `https://www.youtube.com/watch?v=${v.id}`,
        },
      };
    }

    // Official YouTube oEmbed fallback (requires no API key)
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${id}`
    )}&format=json`;
    const oRes = await fetch(oembedUrl, { signal: controller.signal });
    if (!oRes.ok) {
      return { error: 'Video unavailable or embedding disabled' };
    }
    const oData = await oRes.json();
    return {
      item: {
        id: `yt-${id}`,
        title: oData.title || 'YouTube Track',
        artist: oData.author_name?.replace(/\s*-\s*Topic$/i, '') || 'YouTube',
        album: 'YouTube',
        // N-02: duration is UNKNOWN without the Data API — oEmbed does not
        // report it. Returning a fabricated 210s made the room clamp every
        // pasted-URL song back to 3:30. The client reports the real duration
        // via `player:duration` once playback starts.
        durationSec: null,
        coverImage: oData.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        youtubeId: id,
        sourceAttribution: 'YouTube (oEmbed)',
        attributionUrl: `https://www.youtube.com/watch?v=${id}`,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Search YouTube Data API v3 (when YOUTUBE_API_KEY is configured on the backend)
 * filtering strictly for embeddable videos and ranking by normalized metadata.
 */
export async function searchYouTubeVideos(query, maxResults = 6) {
  if (!env.YOUTUBE_API_KEY) {
    return { items: [], configured: false };
  }
  // N-31: stop before burning the daily YouTube Data API quota.
  if (!consumeYouTubeQuota(1)) {
    return { items: [], configured: true, error: 'YouTube search quota exhausted for today' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('videoEmbeddable', 'true');
    searchUrl.searchParams.set('videoCategoryId', '10'); // Music
    searchUrl.searchParams.set('maxResults', String(Math.min(12, maxResults * 2)));
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('key', env.YOUTUBE_API_KEY);

    const searchRes = await fetch(searchUrl, { signal: controller.signal });
    if (!searchRes.ok) {
      throw new Error(`YouTube search HTTP ${searchRes.status}`);
    }
    const searchData = await searchRes.json();
    const videoIds = (searchData.items || [])
      .map((item) => item.id?.videoId)
      .filter(Boolean);

    if (videoIds.length === 0) return { items: [], configured: true };

    if (!consumeYouTubeQuota(1)) {
      return { items: [], configured: true, error: 'YouTube search quota exhausted for today' };
    }
    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.searchParams.set('part', 'snippet,contentDetails,status');
    detailsUrl.searchParams.set('id', videoIds.join(','));
    detailsUrl.searchParams.set('key', env.YOUTUBE_API_KEY);

    const detailsRes = await fetch(detailsUrl, { signal: controller.signal });
    if (!detailsRes.ok) {
      throw new Error(`YouTube videos HTTP ${detailsRes.status}`);
    }
    const detailsData = await detailsRes.json();

    const items = (detailsData.items || [])
      .filter((v) => v.status?.embeddable !== false)
      .filter((v) => !isBadVariantTitle(v.snippet?.title || ''))
      .map((v) => {
        const rawChannel = v.snippet?.channelTitle || '';
        const candidate = {
          id: `yt-${v.id}`,
          title: v.snippet?.title || 'Untitled',
          artist: rawChannel.replace(/\s*-\s*Topic$/i, '') || 'YouTube',
          rawChannel,
          album: 'YouTube Music',
          durationSec: Math.max(15, parseIsoDurationToSec(v.contentDetails?.duration)),
          coverImage:
            v.snippet?.thumbnails?.high?.url ||
            v.snippet?.thumbnails?.medium?.url ||
            null,
          youtubeId: v.id,
          sourceAttribution: 'YouTube',
          attributionUrl: `https://www.youtube.com/watch?v=${v.id}`,
        };
        candidate.matchScore = scoreYouTubeCandidate(candidate, query);
        delete candidate.rawChannel;
        return candidate;
      })
      .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
      .slice(0, maxResults);

    return { items, configured: true };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Search public iTunes Search API (metadata + artwork attribution).
 */
export async function searchItunesCatalog(query, limit = 8) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      query
    )}&media=music&entity=song&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
    const data = await res.json();

    return (data.results || []).map((item) => ({
      id: `itunes-${item.trackId}`,
      title: item.trackName,
      artist: item.artistName,
      album: item.collectionName || 'Single',
      // E-17/I-09: when iTunes has no trackTimeMillis, use 0 instead of a
      // fabricated 3:30 fallback — the UI shows "–:––" and the server won't
      // auto-advance at a wrong time. The real duration is reported by the
      // player once the YouTube video loads.
      durationSec: item.trackTimeMillis ? Math.max(15, Math.round(item.trackTimeMillis / 1000)) : 0,
      coverImage: item.artworkUrl100
        ? item.artworkUrl100.replace('100x100bb', '600x600bb')
        : null,
      // N-01: keep youtubeId null (never fabricate one), but expose the
      // 30-second iTunes preview so the client can play a preview while it
      // resolves the track to a real YouTube video via /api/youtube/resolve.
      previewUrl: item.previewUrl || null,
      youtubeId: null,
      sourceAttribution: 'Apple Music / iTunes',
      attributionUrl: item.trackViewUrl || 'https://music.apple.com',
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve an iTunes-style search result (title + artist) to the best matching
 * embeddable YouTube video (N-01). Only works when YOUTUBE_API_KEY is set;
 * otherwise honestly reports `configured: false` — no scraping, no fabricated IDs.
 */
export async function resolveYouTubeTrack(title, artist = '') {
  if (!env.YOUTUBE_API_KEY) {
    return { item: null, configured: false };
  }
  const query = [String(title || '').trim(), String(artist || '').trim()]
    .filter(Boolean)
    .join(' ');
  const result = await searchYouTubeVideos(query, 6);
  if (result.error) {
    return { item: null, configured: true, error: result.error };
  }
  const items = result.items || [];
  if (items.length === 0) return { item: null, configured: true };
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreYouTubeCandidate(item, title, artist);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return { item: bestScore > 0 ? best : null, configured: true };
}

export async function unifiedSearch(query) {
  const ytId = extractYouTubeId(query);
  if (ytId) {
    const resolved = await lookupYouTubeVideo(ytId);
    if (resolved.item) {
      return {
        items: [resolved.item],
        youtubeConfigured: Boolean(env.YOUTUBE_API_KEY),
      };
    }
    return {
      items: [],
      youtubeConfigured: Boolean(env.YOUTUBE_API_KEY),
      error: resolved.error,
    };
  }

  const normalized = query.trim().toLowerCase();
  if (!normalized) return { items: [], youtubeConfigured: Boolean(env.YOUTUBE_API_KEY) };

  const cached = searchCache.get(normalized);
  if (cached) {
    if (Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.data;
    }
    // N-14: drop expired entries when they are read.
    searchCache.delete(normalized);
  }

  const [ytResult, itunesItems] = await Promise.allSettled([
    searchYouTubeVideos(query, 6),
    searchItunesCatalog(query, 8),
  ]);

  const ytItems = ytResult.status === 'fulfilled' ? ytResult.value.items : [];
  const ytConfigured =
    ytResult.status === 'fulfilled' ? ytResult.value.configured : Boolean(env.YOUTUBE_API_KEY);
  const appleItems = itunesItems.status === 'fulfilled' ? itunesItems.value : [];

  const payload = {
    items: [...ytItems, ...appleItems],
    youtubeConfigured: ytConfigured,
  };

  // N-14: cap the cache at 200 entries (evict oldest first) and drop expired
  // entries when a new entry is written.
  for (const [key, entry] of searchCache.entries()) {
    if (Date.now() - entry.at >= CACHE_TTL_MS) searchCache.delete(key);
  }
  if (!searchCache.has(normalized) && searchCache.size >= MAX_SEARCH_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(normalized, { at: Date.now(), data: payload });
  return payload;
}
