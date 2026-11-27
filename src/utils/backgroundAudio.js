// Tiny 0.1s silent PCM WAV data URI used to keep the mobile browser audio session
// alive when minimized or when the screen is locked.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

class BackgroundAudioManager {
  constructor() {
    this.audioEl = null;
    this.unlocked = false;
    this.isPlaying = false;
    this.handlers = {};
  }

  _ensureAudioEl() {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
    if (!this.audioEl) {
      const el = new Audio(SILENT_WAV_DATA_URI);
      el.loop = true;
      el.volume = 0.001;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.preload = 'auto';
      this.audioEl = el;
    }
    return this.audioEl;
  }

  async unlock() {
    const el = this._ensureAudioEl();
    if (!el) return;
    try {
      await el.play();
      this.unlocked = true;
      if (!this.isPlaying) {
        el.pause();
      }
    } catch {
      // Browser still requires gesture
    }
  }

  async setPlaying(playing) {
    this.isPlaying = Boolean(playing);
    const el = this._ensureAudioEl();
    if (el) {
      if (this.isPlaying) {
        try {
          await el.play();
          this.unlocked = true;
        } catch {
          // Will unlock on next user gesture
        }
      } else {
        try {
          el.pause();
        } catch {
          // Ignore
        }
      }
    }

    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
      } catch {
        // Ignore unsupported browser
      }
    }
  }

  updateMetadata(track) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !track) return;
    if (typeof window.MediaMetadata === 'undefined') return;

    const artwork = [];
    if (track.coverImage) {
      const src = track.coverImage.startsWith('http')
        ? track.coverImage
        : `${window.location.origin}${track.coverImage}`;
      artwork.push({ src, sizes: '512x512', type: 'image/jpeg' });
    }

    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title || 'Unknown Track',
        artist: track.artist || 'Duet',
        album: track.album || 'Duet Synced Room',
        artwork,
      });
    } catch {
      // Ignore unsupported metadata
    }
  }

  updatePosition(positionSec, durationSec) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;
    const dur = Math.max(1, Number(durationSec) || 1);
    const pos = Math.max(0, Math.min(dur, Number(positionSec) || 0));
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: 1,
        position: pos,
      });
    } catch {
      // Ignore invalid position state
    }
  }

  setActionHandlers(handlers = {}) {
    this.handlers = handlers;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const actions = [
      ['play', () => this.handlers.onPlay?.()],
      ['pause', () => this.handlers.onPause?.()],
      ['previoustrack', () => this.handlers.onPrevious?.()],
      ['nexttrack', () => this.handlers.onNext?.()],
      ['seekto', (details) => {
        if (typeof details?.seekTime === 'number') {
          this.handlers.onSeekTo?.(details.seekTime);
        }
      }],
    ];

    for (const [action, fn] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        // Action not supported on this browser
      }
    }
  }

  destroy() {
    this.isPlaying = false;
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.src = '';
      } catch {
        // Ignore
      }
      this.audioEl = null;
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore
        }
      }
    }
  }
}

export const backgroundAudio = new BackgroundAudioManager();
