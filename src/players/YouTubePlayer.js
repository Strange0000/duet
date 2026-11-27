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
            resolve();
          },
          onStateChange: (event) => {
            const YTState = window.YT?.PlayerState;
            if (!YTState) return;
            if (event.data === YTState.PLAYING) {
              this.state = 'playing';
              this.hasPlayedVideoId = this.currentVideoId;
              this.loadIssuedForVideoId = null;
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
            const code = event.data;
            const message = YT_ERROR_MESSAGES[code] || `YouTube player error (${code})`;
            const isEmbedBlocked = code === 101 || code === 150 || code === 100;
            // R1 (follow-up): a failed load must not block a retry — clear
            // the in-flight marker so the next play() can force-load again.
            this.loadIssuedForVideoId = null;
            this.callbacks.onError?.({ code, message, isEmbedBlocked });
          },
        },
      });
    });
  }

  async loadTrack(track, startPositionMs = 0, shouldPlay = false) {
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
      // R1: a same-video re-apply with shouldPlay used to stop at the seek —
      // for a video that was only ever cued, that leaves it paused at 00:00
      // forever. Route through play(), which force-loads a never-played
      // video (see below).
      if (shouldPlay) await this.play();
      return;
    }

    this.currentVideoId = videoId;
    this.hasPlayedVideoId = null;
    this.loadIssuedForVideoId = null;
    if (!this.isReady || !this.player) {
      this.pendingVideo = { videoId, startSec, shouldPlay };
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
    if (!this.isReady || !this.player) {
      // R1: a play() issued while the player is still initialising used to
      // be silently dropped, and the UI spun on "Loading…" forever. Remember
      // the intent so onReady loads AND plays instead of cueing paused.
      if (this.pendingVideo) {
        this.pendingVideo.shouldPlay = true;
      } else if (this.currentVideoId) {
        this.pendingVideo = { videoId: this.currentVideoId, startSec: 0, shouldPlay: true };
      }
      return;
    }
    // R1: a video that was only cued (cueVideoById) often never starts on
    // playVideo() — the live test's first Play sat on "Buffering" at 00:00
    // for ~40s in both YouTube and Audio Only modes, while loadVideoById
    // (the path Next uses) started at once. Force a real load+play for a
    // video that has never actually played yet.
    // R1 (follow-up): but ONLY when no load is already in flight for this
    // video. play() is called again on every room:state re-broadcast
    // (~every second), and re-issuing loadVideoById restarts the buffering
    // from scratch each time — that was the actual stall. While the load
    // is in flight, just call playVideo() (a no-op while buffering) and
    // let the load finish.
    if (this.currentVideoId && this.hasPlayedVideoId !== this.currentVideoId) {
      if (this.loadIssuedForVideoId === this.currentVideoId) {
        this.player.playVideo();
        return;
      }
      let startSec = 0;
      try {
        startSec = Math.max(0, this.player.getCurrentTime?.() || 0);
      } catch {
        // Fall through with startSec 0; the drift loop seeks to the
        // expected position once playback starts.
      }
      this.loadIssuedForVideoId = this.currentVideoId;
      this.player.loadVideoById({ videoId: this.currentVideoId, startSeconds: startSec });
      return;
    }
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
    // R5: right after Next, getDuration() still reports the PREVIOUS video's
    // length until the new video finishes loading. Reporting that would
    // corrupt the new track's duration server-side (player:duration). Return
    // 0 ("unknown") until the video actually loaded is the current one.
    try {
      const url = this.player.getVideoUrl?.();
      if (typeof url === 'string' && url) {
        const loaded = new URL(url).searchParams.get('v');
        if (loaded && this.currentVideoId && loaded !== this.currentVideoId) return 0;
      }
    } catch {
      // Fall through to the real duration when the URL is unreadable.
    }
    return Math.max(0, Math.round(this.player.getDuration() * 1000));
  }

  // The video ID the YouTube player has ACTUALLY loaded right now, parsed
  // from getVideoUrl(). This is the ground truth — currentVideoId is set
  // when loadTrack is called, before the new video finishes loading, so it
  // cannot tell the drift loop whether the new video is on screen yet (B1).
  async getLoadedVideoId() {
    try {
      const url = this.player?.getVideoUrl?.();
      if (typeof url === 'string' && url) {
        const v = new URL(url).searchParams.get('v');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      }
    } catch {
      // Fall through to currentVideoId
    }
    return this.currentVideoId || null;
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
  }
}
