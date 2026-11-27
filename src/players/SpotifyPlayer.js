import { BasePlayer } from './BasePlayer.js';
import { getValidSpotifyToken, resolveSpotifyUri } from '../utils/spotifyAuth.js';

let sdkPromise = null;

const SPOTIFY_LOAD_TIMEOUT_MS = 15000;

function loadSpotifySDK() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Spotify SDK requires a browser environment'));
  }
  if (window.Spotify && window.Spotify.Player) {
    return Promise.resolve(window.Spotify);
  }
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    let settled = false;
    const prevReady = window.onSpotifyWebPlaybackSDKReady;

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      sdkPromise = null;
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      if (!window.Spotify || !window.Spotify.Player) return;
      settled = true;
      cleanup();
      resolve(window.Spotify);
    };

    // 15s timeout + polling: if the script tag already exists but the SDK
    // never loads (ad-blocker, failed earlier load), never hang forever (N-07).
    const timer = setTimeout(
      () => fail(new Error('Spotify player failed to load — check your connection or ad-blocker')),
      SPOTIFY_LOAD_TIMEOUT_MS
    );
    const poll = setInterval(succeed, 250);

    window.onSpotifyWebPlaybackSDKReady = () => {
      if (typeof prevReady === 'function') prevReady();
      succeed();
    };

    if (!document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]')) {
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      script.onerror = () => fail(new Error('Failed to load Spotify Web Playback SDK'));
      document.head.appendChild(script);
    }
  });

  return sdkPromise;
}

export class SpotifyPlayer extends BasePlayer {
  constructor(callbacks = {}) {
    super(callbacks);
    this.player = null;
    this.deviceId = null;
    this.isReady = false;
    this.state = 'idle';
    this.currentUri = null;
    this.lastPositionMs = 0;
    this.lastDurationMs = 0;
    this.lastUpdateMono = 0;
    this.wasPlaying = false;
    this.volume = 0.85;
    this.muted = false;
  }

  getCapabilities() {
    return {
      canSeek: true,
      canAdjustSpeed: false,
      canReportPosition: true,
      requiresGesture: true,
      hasNativeControls: false,
      canSchedule: false,
      backgroundPlayback: true,
    };
  }

  async initialize() {
    const token = await getValidSpotifyToken();
    if (!token) {
      throw new Error('Please connect your Spotify Premium account first.');
    }

    const Spotify = await loadSpotifySDK();

    await new Promise((resolve, reject) => {
      let settled = false;
      this.player = new Spotify.Player({
        name: 'Duet Synced Player',
        getOAuthToken: async (cb) => {
          const fresh = await getValidSpotifyToken();
          if (fresh) {
            cb(fresh);
            return;
          }
          // N-22: never call cb('') and never leave the SDK waiting silently
          // with no token — surface the auth failure so the UI shows it.
          this.callbacks.onError?.({
            code: 'SPOTIFY_AUTH',
            message: 'Spotify session expired — please reconnect Spotify.',
          });
        },
        volume: this.muted ? 0 : this.volume,
      });

      this.player.addListener('ready', ({ device_id }) => {
        this.deviceId = device_id;
        this.isReady = true;
        this.state = 'ready';
        this.callbacks.onReady?.();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.player.addListener('not_ready', () => {
        this.isReady = false;
      });

      this.player.addListener('initialization_error', ({ message }) => {
        const err = { code: 'SPOTIFY_INIT', message };
        this.callbacks.onError?.(err);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      });

      this.player.addListener('authentication_error', ({ message }) => {
        const err = { code: 'SPOTIFY_AUTH', message: `Spotify auth error: ${message}` };
        this.callbacks.onError?.(err);
        if (!settled) {
          settled = true;
          reject(new Error(err.message));
        }
      });

      this.player.addListener('account_error', () => {
        const err = {
          code: 'SPOTIFY_PREMIUM_REQUIRED',
          message: 'Spotify Premium is required to stream music in the browser. Switch to YouTube or Audio Only if you use Spotify Free.',
        };
        this.callbacks.onError?.(err);
        if (!settled) {
          settled = true;
          reject(new Error(err.message));
        }
      });

      this.player.addListener('playback_error', ({ message }) => {
        this.callbacks.onError?.({ code: 'SPOTIFY_PLAYBACK', message });
      });

      this.player.addListener('player_state_changed', (state) => {
        if (!state) return;
        this.lastPositionMs = state.position || 0;
        this.lastDurationMs = state.duration || 0;
        this.lastUpdateMono = performance.now();

        const nextState = state.paused ? 'paused' : 'playing';
        if (
          this.wasPlaying &&
          state.paused &&
          state.position === 0 &&
          state.track_window?.previous_tracks?.length > 0
        ) {
          this.state = 'ended';
          this.wasPlaying = false;
          this.callbacks.onStateChange?.('ended');
          this.callbacks.onEnded?.();
          return;
        }

        this.wasPlaying = !state.paused;
        this.state = nextState;
        this.callbacks.onStateChange?.(nextState);
      });

      this.player.connect().then((success) => {
        if (!success && !settled) {
          settled = true;
          reject(new Error('Could not connect Spotify Web Playback SDK'));
        }
      });
    });
  }

  async loadTrack(track, startPositionMs = 0, _shouldPlay = false) {
    const token = await getValidSpotifyToken();
    if (!token || !this.deviceId) return;

    const uri = await resolveSpotifyUri(track, token);
    if (!uri) {
      this.callbacks.onError?.({
        code: 'SPOTIFY_NOT_FOUND',
        message: `Could not find "${track?.title || 'this track'}" on Spotify.`,
      });
      return;
    }

    if (this.currentUri === uri) {
      await this.seek(startPositionMs);
      return;
    }

    this.currentUri = uri;
    this.lastPositionMs = startPositionMs;
    this.lastUpdateMono = performance.now();

    const res = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          uris: [uri],
          position_ms: Math.max(0, Math.round(startPositionMs)),
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg =
        res.status === 403
          ? 'Spotify Premium is required to play full tracks in the browser.'
          : errBody?.error?.message || `Spotify playback failed (${res.status})`;
      this.callbacks.onError?.({ code: 'SPOTIFY_PLAY_FAILED', message: msg });
    }
  }

  async play() {
    if (!this.player) return;
    try {
      await this.player.activateElement?.();
      await this.player.resume();
    } catch {
      // Fallback via Web API if SDK resume fails
      const token = await getValidSpotifyToken();
      if (token && this.deviceId) {
        await fetch(
          `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }
        ).catch(() => {});
      }
    }
  }

  async pause() {
    if (!this.player) return;
    await this.player.pause().catch(() => {});
  }

  async seek(positionMs) {
    if (!this.player) return;
    this.lastPositionMs = Math.max(0, Math.round(positionMs));
    this.lastUpdateMono = performance.now();
    await this.player.seek(this.lastPositionMs).catch(() => {});
  }

  async getPosition() {
    if (this.player && typeof this.player.getCurrentState === 'function') {
      const st = await this.player.getCurrentState().catch(() => null);
      if (st) {
        this.lastPositionMs = st.position || 0;
        this.lastUpdateMono = performance.now();
        return this.lastPositionMs;
      }
    }
    if (this.state === 'playing' && this.lastUpdateMono > 0) {
      return this.lastPositionMs + (performance.now() - this.lastUpdateMono);
    }
    return this.lastPositionMs;
  }

  async getDuration() {
    return this.lastDurationMs;
  }

  async getState() {
    return this.state;
  }

  async setVolume(volume01) {
    this.volume = Math.max(0, Math.min(1, Number(volume01) || 0));
    if (!this.player || typeof this.player.setVolume !== 'function') return;
    try {
      // The Web Playback SDK has no mute; mute is emulated via volume 0.
      await this.player.setVolume(this.muted ? 0 : this.volume);
    } catch {
      // Ignore
    }
  }

  async setMuted(muted) {
    this.muted = Boolean(muted);
    await this.setVolume(this.volume);
  }

  async getVolume() {
    if (this.player && typeof this.player.getVolume === 'function') {
      try {
        const v = await this.player.getVolume();
        if (typeof v === 'number') return Math.max(0, Math.min(1, v));
      } catch {
        // Fall through to the stored value
      }
    }
    return this.muted ? 0 : this.volume;
  }

  async destroy() {
    try {
      this.player?.disconnect?.();
    } catch {
      // Ignore
    }
    this.player = null;
    this.deviceId = null;
    this.isReady = false;
    this.currentUri = null;
  }
}
