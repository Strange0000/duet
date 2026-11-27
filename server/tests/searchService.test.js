import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  extractYouTubeId,
  scoreYouTubeCandidate,
  parseIsoDurationToSec,
  searchItunesCatalog,
  lookupYouTubeVideo,
  searchYouTubeVideos,
  resolveYouTubeTrack,
  __setYouTubeQuotaForTest,
} from '../src/services/searchService.js';
import { env } from '../src/config/env.js';

describe('YouTube search & URL helpers', () => {
  it('extracts valid 11-char video IDs from watch, short, embed, and raw IDs', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
    expect(extractYouTubeId('https://youtu.be/8GW6sLrK40k?si=abc')).toBe('8GW6sLrK40k');
    expect(extractYouTubeId('https://music.youtube.com/watch?v=a5uQMwRMHcs')).toBe('a5uQMwRMHcs');
    expect(extractYouTubeId('dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
    expect(extractYouTubeId('not a youtube link')).toBeNull();
  });

  it('rejects lookalike hosts but allows real YouTube subdomains (N-27)', () => {
    expect(extractYouTubeId('https://notyoutube.com/watch?v=dX3k_QDnzHE')).toBeNull();
    expect(extractYouTubeId('https://evil-youtu.be/dX3k_QDnzHE')).toBeNull();
    expect(extractYouTubeId('https://www.notyoutube.com/watch?v=dX3k_QDnzHE')).toBeNull();
    expect(extractYouTubeId('https://m.youtube.com/watch?v=dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
    expect(extractYouTubeId('https://www.youtu.be/dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
    expect(extractYouTubeId('https://youtube.com/shorts/dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
  });

  it('parses ISO 8601 durations with days and fractional seconds (N-28)', () => {
    expect(parseIsoDurationToSec('PT4M3S')).toBe(243);
    expect(parseIsoDurationToSec('PT1M30.5S')).toBe(90.5);
    expect(parseIsoDurationToSec('P1DT2H3M4S')).toBe(86400 + 7200 + 180 + 4);
    expect(parseIsoDurationToSec('P1D')).toBe(86400);
    expect(parseIsoDurationToSec('PT2H')).toBe(7200);
    expect(parseIsoDurationToSec('')).toBe(0);
    expect(parseIsoDurationToSec('not-a-duration')).toBe(0);
  });

  it('scores official audio/video candidates with matching duration higher', () => {
    const official = scoreYouTubeCandidate(
      {
        title: 'M83 - Midnight City (Official Audio)',
        artist: 'M83',
        rawChannel: 'M83 - Topic',
        durationSec: 243,
      },
      'Midnight City',
      'M83',
      243
    );
    const mismatch = scoreYouTubeCandidate(
      {
        title: 'Random Acoustic Guitar Session',
        artist: 'Someone',
        rawChannel: 'RandomChannel',
        durationSec: 400,
      },
      'Midnight City',
      'M83',
      243
    );

    expect(official).toBeGreaterThan(mismatch);
    expect(official).toBeGreaterThanOrEqual(80);
  });
});

describe('searchService API behaviour (fetch stubbed)', () => {
  const originalKey = env.YOUTUBE_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    env.YOUTUBE_API_KEY = originalKey;
    __setYouTubeQuotaForTest(0);
  });

  it('iTunes results keep youtubeId null but include the 30s preview URL (N-01)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          results: [
            {
              trackId: 123,
              trackName: 'Midnight City',
              artistName: 'M83',
              collectionName: 'Hurry Up',
              trackTimeMillis: 243000,
              artworkUrl100: 'https://example.com/art/100x100bb.jpg',
              previewUrl: 'https://audio.example.com/preview.m4a',
              trackViewUrl: 'https://music.apple.com/track/123',
            },
          ],
        }),
      }))
    );
    const items = await searchItunesCatalog('Midnight City', 1);
    expect(items).toHaveLength(1);
    expect(items[0].youtubeId).toBeNull();
    expect(items[0].previewUrl).toBe('https://audio.example.com/preview.m4a');
    expect(items[0].durationSec).toBe(243);
  });

  it('oEmbed fallback returns durationSec null, not a fabricated 210 (N-02)', async () => {
    env.YOUTUBE_API_KEY = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          title: 'M83 - Midnight City',
          author_name: 'M83',
          thumbnail_url: 'https://i.ytimg.com/vi/dX3k_QDnzHE/hqdefault.jpg',
        }),
      }))
    );
    const res = await lookupYouTubeVideo('dX3k_QDnzHE');
    expect(res.error).toBeUndefined();
    expect(res.item.durationSec).toBeNull();
    expect(res.item.youtubeId).toBe('dX3k_QDnzHE');
  });

  it('resolveYouTubeTrack reports configured:false with no API key and never scrapes (N-01)', async () => {
    env.YOUTUBE_API_KEY = '';
    const fetchSpy = vi.fn(async () => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await resolveYouTubeTrack('Midnight City', 'M83');
    expect(res).toEqual({ item: null, configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('YouTube quota guard refuses API calls once the daily cap is hit (N-31)', async () => {
    env.YOUTUBE_API_KEY = 'test-key';
    __setYouTubeQuotaForTest(9000);
    const fetchSpy = vi.fn(async () => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const search = await searchYouTubeVideos('Midnight City', 6);
    expect(search.error).toBe('YouTube search quota exhausted for today');
    expect(search.items).toEqual([]);

    const lookup = await lookupYouTubeVideo('dX3k_QDnzHE');
    expect(lookup.error).toBe('YouTube search quota exhausted for today');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
