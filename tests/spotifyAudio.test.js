// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyPlayer } from '../src/players/SpotifyPlayer.js';
import { resolveSpotifyUri } from '../src/utils/spotifyAuth.js';
import { trackSchema } from '../server/src/validators/events.js';

const track = { title: 'Midnight City (Official Video)', artist: 'M83 - Topic' };
const recording = (uri, name, artist) => ({ uri, name, artists: [{ name: artist }] });

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Spotify Audio Only', () => {
  it('keeps a known Spotify recording ID in room queue entries', () => {
    const queuedTrack = { ...track, id: 'track-1', durationSec: 243, spotifyUri: 'spotify:track:original123' };
    expect(trackSchema.parse(queuedTrack).spotifyUri).toBe(queuedTrack.spotifyUri);
  });

  it('skips a cover and accepts the matching Spotify recording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: { items: [
        recording('spotify:track:cover123', 'Midnight City', 'Piano Radio'),
        recording('spotify:track:original123', 'Midnight City', 'M83'),
      ] } }),
    }));
    await expect(resolveSpotifyUri(track, 'test-token')).resolves.toBe('spotify:track:original123');
  });

  it('leaves an unsupported recording unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: { items: [recording('spotify:track:remix123', 'Midnight City - Remix', 'M83')] } }),
    }));
    await expect(resolveSpotifyUri(track, 'test-token')).resolves.toBeNull();
  });

  it('rejects when the SDK connects but never reports a ready device', async () => {
    vi.useFakeTimers();
    localStorage.setItem('duet_spotify_auth', JSON.stringify({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    }));
    vi.stubGlobal('Spotify', {
      Player: function () {
        return { addListener: vi.fn(), connect: vi.fn().mockResolvedValue(true) };
      },
    });

    try {
      const initialization = expect(new SpotifyPlayer().initialize()).rejects.toThrow('Spotify did not become ready');
      await vi.advanceTimersByTimeAsync(15000);
      await initialization;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cues a paused room and requests the original URI at the current seek position on play', async () => {
    localStorage.setItem('duet_spotify_auth', JSON.stringify({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    }));
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);
    const player = new SpotifyPlayer();
    player.deviceId = 'test-device';
    player.player = { pause: vi.fn().mockResolvedValue() };
    await player.loadTrack({ ...track, spotifyUri: 'spotify:track:original123' }, 4000, false);
    expect(fetch).not.toHaveBeenCalled();
    await player.seek(6000);
    await player.play();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toContain('device_id=test-device');
    expect(JSON.parse(options.body)).toEqual({ uris: ['spotify:track:original123'], position_ms: 6000 });
  });
});
