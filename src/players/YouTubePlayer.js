import { BasePlayer } from './BasePlayer.js';

let ytApiPromise = null;

function loadYouTubeIframeAPI() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube API requires a browser environment'));
  }
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    const prevReady = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady();
      resolve(window.YT);
    };

    if (!existingScript) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
      document.head.appendChild(tag);
    }
  });

  return ytApiPromise;
}

const YT_ERROR_MESSAGES = {
  2: 'Invalid YouTube video ID.',
  5: 'HTML5 player playback error.',
  100: 'This video was removed or marked private.',
  101: 'The video owner disabled playback on external sites.',
  150: 'The video owner disabled embedding for this track.',
};

/**
 * Official YouTube IFrame Player API adapter.
 * Always renders into a visible, properly sized container with native controls & branding preserved.
 */
export class YouTubePlayer extends BasePlayer {
  constructor(callbacks = {}) {
    super(callbacks);
    this.player = null;
    this.containerEl = null;
    this.currentVideoId = null;
    this.state = 'idle';
    this.isReady = false;
    this.pendingVideo = null;
  }

  getCapabilities() {
    return {
      canSeek: true,
      canAdjustSpeed: false,
      canReportPosition: true,
      requiresGesture: true,
      hasNativeControls: true,
      canSchedule: false,
      backgroundPlayback: false,
    };
  }

  async initialize(containerEl) {
    if (!containerEl) throw new Error('Visible YouTube container element is required');
    this.containerEl = containerEl;
    const YT = await loadYouTubeIframeAPI();

    // Ensure mount node inside container
    containerEl.innerHTML = '';
    const mountEl = document.createElement('div');
    mountEl.style.width = '100%';
    mountEl.style.height = '100%';
    containerEl.appendChild(mountEl);

    await new Promise((resolve) => {
      this.player = new YT.Player(mountEl, {
        width: '100%',
        height: '100%',
        playerVars: {
          playsinline: 1,
          controls: 1,
          rel: 0,
          modestbranding: 0,
          origin: window.location.origin,
          enablejsapi: 1,
        },
        events: {
          onReady: () => {
            this.isReady = true;
            this.state = 'ready';
            this.callbacks.onReady?.();
            if (this.pendingVideo) {
              const { videoId, startSec } = this.pendingVideo;
              this.pendingVideo = null;
              this.player.cueVideoById({ videoId, startSeconds: startSec });
            }
            resolve();
          },
          onStateChange: (event) => {
            const YTState = window.YT?.PlayerState;
            if (!YTState) return;
            if (event.data === YTState.PLAYING) {
              this.state = 'playing';
              this.callbacks.onStateChange?.('playing');
            } else if (event.data === YTState.PAUSED) {
              this.state = 'paused';
              this.callbacks.onStateChange?.('paused');
            } else if (event.data === YTState.BUFFERING) {
              this.state = 'buffering';
              this.callbacks.onStateChange?.('buffering');
            } else if (event.data === YTState.ENDED) {
              this.state = 'ended';
              this.callbacks.onStateChange?.('ended');
              this.callbacks.onEnded?.();
            }
          },
          onError: (event) => {
            const code = event.data;
            const message = YT_ERROR_MESSAGES[code] || `YouTube player error (${code})`;
            const isEmbedBlocked = code === 101 || code === 150 || code === 100;
            this.callbacks.onError?.({ code, message, isEmbedBlocked });
          },
        },
      });
    });
  }

  async loadTrack(track, startPositionMs = 0) {
    const videoId = track?.youtubeId;
    if (!videoId) {
      this.callbacks.onError?.({
        code: 'NO_YOUTUBE_ID',
        message: 'This track does not have a verified embeddable YouTube video ID.',
        isEmbedBlocked: true,
      });
      return;
    }

    const startSec = Math.max(0, startPositionMs / 1000);
    if (this.currentVideoId === videoId) {
      await this.seek(startPositionMs);
      return;
    }

    this.currentVideoId = videoId;
    if (!this.isReady || !this.player) {
      this.pendingVideo = { videoId, startSec };
      return;
    }

    this.player.cueVideoById({ videoId, startSeconds: startSec });
  }

  async play() {
    if (!this.isReady || !this.player) return;
    this.player.playVideo();
  }

  async pause() {
    if (!this.isReady || !this.player) return;
    this.player.pauseVideo();
  }

  async seek(positionMs) {
    if (!this.isReady || !this.player) return;
    this.player.seekTo(Math.max(0, positionMs / 1000), true);
  }

  async getPosition() {
    if (!this.isReady || !this.player || typeof this.player.getCurrentTime !== 'function') {
      return 0;
    }
    return Math.max(0, Math.round(this.player.getCurrentTime() * 1000));
  }

  async getDuration() {
    if (!this.isReady || !this.player || typeof this.player.getDuration !== 'function') {
      return 0;
    }
    return Math.max(0, Math.round(this.player.getDuration() * 1000));
  }

  async getState() {
    return this.state;
  }

  async destroy() {
    try {
      this.player?.destroy?.();
    } catch {
      // Ignore cleanup error
    }
    this.player = null;
    this.isReady = false;
    this.currentVideoId = null;
  }
}
