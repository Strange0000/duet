import { BasePlayer } from './BasePlayer.js';

let ytApiPromise = null;

const YT_LOAD_TIMEOUT_MS = 15000;

function loadYouTubeIframeAPI() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube API requires a browser environment'));
  }
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    let settled = false;
    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    const prevReady = window.onYouTubeIframeAPIReady;

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      ytApiPromise = null;
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      if (!window.YT || !window.YT.Player) return;
      settled = true;
      cleanup();
      resolve(window.YT);
    };

    // 15s timeout: the script tag may already exist (or be blocked by an
    // ad-blocker) yet the API never loads — never hang forever (N-07).
    const timer = setTimeout(
      () => fail(new Error('YouTube player failed to load — check your connection or ad-blocker')),
      YT_LOAD_TIMEOUT_MS
    );
    // Poll as well as waiting on the callback: if the script tag already
    // exists but the ready callback never fires, the poll still notices.
    const poll = setInterval(succeed, 250);

    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady();
      succeed();
    };

    if (!existingScript) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => fail(new Error('Failed to load YouTube IFrame API'));
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
    // R1: the videoId that has actually reached PLAYING at least once.
    // A video that was only cued (cueVideoById) often never starts when
    // playVideo() is called on it — it sits on "Buffering" at 00:00.
    this.hasPlayedVideoId = null;
    // R1 (follow-up): the videoId a loadVideoById was issued for and which
    // has not yet reached PLAYING. Re-issuing loadVideoById for the same
    // video restarts its buffering from scratch — and the room state is
    // re-broadcast ~every second, so play() was called again and again and
    // a first Play never finished loading. A play() that arrives while the
    // load is already in flight must NOT reload; it just calls playVideo().
    this.loadIssuedForVideoId = null;
    this.playerFailed = false;
    this.waitingForLateStart = false;
    this.recoveredVideoId = null;
    this.playerGeneration = 0;
    this.cancelInitialization = null;
    this.recovery = null;
    this.volume = 0.85;
    this.muted = false;
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
    const generation = ++this.playerGeneration;
    const YT = await loadYouTubeIframeAPI();

    if (generation !== this.playerGeneration) return;

    // Ensure mount node inside container
    containerEl.innerHTML = '';
    const mountEl = document.createElement('div');
    mountEl.style.width = '100%';
    mountEl.style.height = '100%';
    containerEl.appendChild(mountEl);

    await new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        this.cancelInitialization = null;
        resolve();
      };
      const timeout = setTimeout(() => {
        this.cancelInitialization = null;
        this.markFailed();
        reject(new Error('YouTube iframe did not become ready'));
      }, YT_LOAD_TIMEOUT_MS);
      this.cancelInitialization = finish;
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
            if (generation !== this.playerGeneration || this.playerFailed) return;
            this.isReady = true;
            this.state = 'ready';
            this.callbacks.onReady?.();
            if (this.pendingVideo) {
              const { videoId, startSec, shouldPlay } = this.pendingVideo;
              this.pendingVideo = null;
              // B1: load AND play when the room is playing, otherwise cue paused.
              if (shouldPlay) {
                this.loadIssuedForVideoId = videoId;
                this.player.loadVideoById({ videoId, startSeconds: startSec });
              } else {
                this.player.cueVideoById({ videoId, startSeconds: startSec });
              }
            }
            // Apply any volume/muted state set before the player was ready.
            try {
              this.player.setVolume(Math.round(this.volume * 100));
              if (this.muted) this.player.mute();
            } catch {
              // Ignore — volume can be re-applied later via setVolume/setMuted
            }
            finish();
          },
          onStateChange: (event) => {
            if (generation !== this.playerGeneration) return;
            const YTState = window.YT?.PlayerState;
            if (!YTState) return;
            const loadedId = this.readLoadedVideoId();
            if (this.playerFailed && !(this.waitingForLateStart &&
                event.data === YTState.PLAYING && loadedId && loadedId === this.currentVideoId)) return;
            if (loadedId && loadedId !== this.currentVideoId &&
                (event.data === YTState.PLAYING || event.data === YTState.ENDED)) return;
            if (event.data === YTState.PLAYING) {
              this.state = 'playing';
              this.hasPlayedVideoId = this.currentVideoId;
              this.loadIssuedForVideoId = null;
              // F1: a successful play clears the failure — a later error
              // for this video gets a fresh recovery budget.
              this.playerFailed = false;
              this.waitingForLateStart = false;
              this.recoveredVideoId = null;
              this.callbacks.onStateChange?.('playing');
            } else if (event.data === YTState.PAUSED) {
              this.state = 'paused';
              this.callbacks.onStateChange?.('paused');
            } else if (event.data === YTState.BUFFERING) {
              this.state = 'buffering';
              this.callbacks.onStateChange?.('buffering');
            } else if (event.data === YTState.CUED) {
              // R1 (follow-up): a cued video is loaded but not started — the
              // state the player sits in between cueVideoById and the first
              // play(). Callers use it to tell "not started yet" from
              // "started and buffering".
              this.state = 'cued';
              this.callbacks.onStateChange?.('cued');
            } else if (event.data === YTState.UNSTARTED) {
              this.state = 'unstarted';
              this.callbacks.onStateChange?.('unstarted');
            } else if (event.data === YTState.ENDED) {
              this.state = 'ended';
              this.callbacks.onStateChange?.('ended');
              this.callbacks.onEnded?.();
            }
          },
          onError: (event) => {
            if (generation !== this.playerGeneration) return;
            const code = event.data;
            const message = YT_ERROR_MESSAGES[code] || `YouTube player error (${code})`;
            const isEmbedBlocked = code === 101 || code === 150 || code === 100;
            this.markFailed();
            this.callbacks.onError?.({ code, message, isEmbedBlocked });
          },
        },
      });
    });
  }

  markFailed({ allowLateStart = false } = {}) {
    this.playerFailed = true;
    this.waitingForLateStart = allowLateStart;
    this.hasPlayedVideoId = null;
    this.loadIssuedForVideoId = null;
    this.state = 'error';
    this.callbacks.onStateChange?.('error');
  }

  rebuildPlayer() {
    // Invalidate the old callbacks before destroy(), which can emit events.
    this.playerGeneration += 1;
    this.cancelInitialization?.();
    try {
      this.player?.destroy?.();
    } catch {
      // Rebuilding can proceed even if the old iframe is already gone.
    }
    this.player = null;
    this.isReady = false;
    this.playerFailed = false;
    this.waitingForLateStart = false;
    this.hasPlayedVideoId = null;
    this.loadIssuedForVideoId = null;
    this.state = 'buffering';
    this.callbacks.onStateChange?.('buffering');
    this.recovery = this.initialize(this.containerEl).finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }

  async loadTrack(track, startPositionMs = 0, shouldPlay = false) {
    const videoId = track?.youtubeId;
    if (!videoId) {
      await this.pause();
      this.currentVideoId = null;
      this.pendingVideo = null;
      this.markFailed();
      this.callbacks.onError?.({
        code: 'NO_YOUTUBE_ID',
        message: 'This track does not have a verified embeddable YouTube video ID.',
        isEmbedBlocked: true,
      });
      return;
    }

    const startSec = Math.max(0, startPositionMs / 1000);
    this.requestedStartSec = startSec;
    if (this.playerFailed && this.containerEl) {
      // A new queue item gets a fresh iframe even if retrying the old
      // video already exhausted its retry. Keep the latest load intent
      // while the replacement iframe is becoming ready.
      this.currentVideoId = videoId;
      this.recoveredVideoId = null;
      this.pendingVideo = { videoId, startSec, shouldPlay };
      await this.rebuildPlayer();
      return;
    }

    if (this.currentVideoId === videoId && this.isReady) {
      await this.seek(startPositionMs);
      if (shouldPlay) await this.play();
      else await this.pause();
      return;
    }

    this.currentVideoId = videoId;
    this.hasPlayedVideoId = null;
    this.loadIssuedForVideoId = null;
    this.recoveredVideoId = null;
    this.state = shouldPlay ? 'buffering' : 'cued';
    this.callbacks.onStateChange?.(this.state);
    if (!this.isReady || !this.player) {
      this.pendingVideo = { videoId, startSec, shouldPlay };
      await this.recovery;
      return;
    }

    // B1: cueVideoById loads paused, so a play() issued right after it is
    // lost while the video is still loading and the OLD video keeps playing.
    // loadVideoById loads AND plays, so use it when the room is playing.
    if (shouldPlay) {
      this.loadIssuedForVideoId = videoId;
      this.player.loadVideoById({ videoId, startSeconds: startSec });
    } else {
      this.player.cueVideoById({ videoId, startSeconds: startSec });
    }
  }

  async play() {
    if (this.playerFailed) {
      const videoId = this.currentVideoId;
      if (!videoId || !this.containerEl || this.recoveredVideoId === videoId) return;
      this.recoveredVideoId = videoId;
      this.pendingVideo = { videoId, startSec: this.requestedStartSec ?? 0, shouldPlay: true };
      await this.rebuildPlayer();
      return;
    }
    if (!this.isReady || !this.player) {
      if (this.pendingVideo) this.pendingVideo.shouldPlay = true;
      return;
    }
    if (this.currentVideoId && this.hasPlayedVideoId !== this.currentVideoId) {
      if (this.loadIssuedForVideoId === this.currentVideoId) {
        this.player.playVideo();
        return;
      }
      const startSec = this.requestedStartSec ?? 0;
      this.loadIssuedForVideoId = this.currentVideoId;
      this.player.loadVideoById({ videoId: this.currentVideoId, startSeconds: startSec });
      return;
    }
    this.player.playVideo();
  }

  async pause() {
    if (this.pendingVideo) this.pendingVideo.shouldPlay = false;
    if (!this.isReady || !this.player || this.playerFailed) return;
    this.player.pauseVideo();
  }

  async seek(positionMs) {
    this.requestedStartSec = Math.max(0, positionMs / 1000);
    if (this.pendingVideo) this.pendingVideo.startSec = this.requestedStartSec;
    if (!this.isReady || !this.player || this.playerFailed) return;
    this.player.seekTo(this.requestedStartSec, true);
  }

  async getPosition() {
    if (!(await this.getLoadedVideoId())) return 0;
    return Math.max(0, Math.round((this.player?.getCurrentTime?.() || 0) * 1000));
  }

  async getDuration() {
    if (!this.currentVideoId || this.hasPlayedVideoId !== this.currentVideoId ||
        !(await this.getLoadedVideoId())) return 0;
    return Math.max(0, Math.round((this.player?.getDuration?.() || 0) * 1000));
  }

  readLoadedVideoId() {
    try {
      return new URL(this.player?.getVideoUrl?.()).searchParams.get('v');
    } catch {
      return null;
    }
  }

  async getLoadedVideoId() {
    if (!this.isReady || this.playerFailed || !this.currentVideoId) return null;
    const loadedId = this.readLoadedVideoId();
    return loadedId === this.currentVideoId ? loadedId : null;
  }

  async getState() {
    return this.state;
  }

  async setVolume(volume01) {
    this.volume = Math.max(0, Math.min(1, Number(volume01) || 0));
    if (!this.isReady || !this.player || typeof this.player.setVolume !== 'function') return;
    try {
      this.player.setVolume(Math.round(this.volume * 100));
    } catch {
      // Ignore
    }
  }

  async setMuted(muted) {
    this.muted = Boolean(muted);
    if (!this.isReady || !this.player) return;
    try {
      if (this.muted) this.player.mute();
      else this.player.unMute();
    } catch {
      // Ignore
    }
  }

  async getVolume() {
    if (this.isReady && this.player && typeof this.player.getVolume === 'function') {
      try {
        return Math.max(0, Math.min(1, this.player.getVolume() / 100));
      } catch {
        // Fall through to the stored value
      }
    }
    return this.muted ? 0 : this.volume;
  }

  async destroy() {
    this.playerGeneration += 1;
    this.cancelInitialization?.();
    try {
      this.player?.destroy?.();
    } catch {
      // Ignore cleanup error
    }
    this.player = null;
    this.isReady = false;
    this.currentVideoId = null;
    this.hasPlayedVideoId = null;
    this.loadIssuedForVideoId = null;
    this.pendingVideo = null;
    this.playerFailed = false;
    this.recoveredVideoId = null;
  }
}
