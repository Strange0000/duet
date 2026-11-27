import { describe, it, expect } from 'vitest';
import { extractYouTubeId, scoreYouTubeCandidate } from '../src/services/searchService.js';

describe('YouTube search & URL helpers', () => {
  it('extracts valid 11-char video IDs from watch, short, embed, and raw IDs', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
    expect(extractYouTubeId('https://youtu.be/8GW6sLrK40k?si=abc')).toBe('8GW6sLrK40k');
    expect(extractYouTubeId('https://music.youtube.com/watch?v=a5uQMwRMHcs')).toBe('a5uQMwRMHcs');
    expect(extractYouTubeId('dX3k_QDnzHE')).toBe('dX3k_QDnzHE');
    expect(extractYouTubeId('not a youtube link')).toBeNull();
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
