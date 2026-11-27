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
    // F1 (PR #5 follow-up): the videoId whose load last failed, and whether
    // the player instance itself is suspect. The live re-test showed that
    // once one load errored (embedding-disabled), EVERY later load failed —
    // including a video that had played fine minutes earlier — and the
    // watchdog's single play() retry (which re-issues loadVideoById) failed
    // too. Whether the instance is dead or YouTube refused transiently, the
    // only in-code recovery is a fresh player instance (recoverIfFailed,
    // bounded to once per video).
    this.playerFailed = false;
    this.failedVideoId = null;
    this.recoveredVideoId = null;
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
            // F1: while a load has failed, stray state changes (UNSTARTED /
            // CUED / BUFFERING from the dead load) must not overwrite the
            // 'error' state — otherwise the dedup treats the player as
            // "already trying" and never retries, and the pill lies. Only
            // PLAYING (recovered) and ENDED may pass through.
            if (
              this.playerFailed &&
              event.data !== YTState.PLAYING &&
              event.data !== YTState.ENDED
            ) {
              return;
            }
            if (event.data === YTState.PLAYING) {
              this.state = 'playing';
              this.hasPlayedVideoId = this.currentVideoId;
              this.loadIssuedForVideoId = null;
              // F1: a successful play clears the failure — a later error
              // for this video gets a fresh recovery budget.
              this.playerFailed = false;
              this.failedVideoId = null;
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
            const code = event.data;
            const message = YT_ERROR_MESSAGES[code] || `YouTube player error (${code})`;
            const isEmbedBlocked = code === 101 || code === 150 || code === 100;
            // F1: a failed load must not block a retry — clear
            // the in-flight marker so the next play() can force-load again.
            this.loadIssuedForVideoId = null;
            // F1: record the failure as STATE, not just a callback. Before
            // this, `this.state` stayed 'buffering' after an error, so the
            // dedup (shouldReapplyPlayback) treated the player as "already
            // trying to start" and the effect never retried — the player sat
            // on YouTube's error screen forever. 'error' is not in the
            // dedup's leave-alone list, so a re-apply is now allowed, and
            // the status pill shows the failure honestly instead of
            // "Buffering". The instance itself is marked suspect: the live
            // re-test showed every later load failing after one error, so
            // the next load/play recreates the player (once per video).
            this.state = 'error';
            const isLoadFailure = code === 2 || code === 5 || code === 100 || code === 101 || code === 150;
            if (isLoadFailure && this.currentVideoId) {
              this.playerFailed = true;
              this.failedVideoId = this.currentVideoId;
            }
            this.callbacks.onStateChange?.('error');
            this.callbacks.onError?.({ code, message, isEmbedBlocked });
          },
        },
      });
    });
  }

  /**
   * F1: recreate the player instance after a load failure, bounded to once
   * per video. A failed YT.Player can refuse every later load (the live
   * re-test: even a video that had played fine minutes earlier showed
   * "Video unavailable" after one error), so retrying loadVideoById on the
   * same instance is not a recovery. A fresh instance is. The bound keeps a
   * genuinely blocked video from thrashing the iframe on every room:state
   * re-broadcast (~1/s): after one recovery for a video, further failures
   * for that video surface the error banner (with "Play next song") instead
   * of re-creating the player again. Returns true when a recovery happened.
   * Safe to call when nothing failed (returns false immediately).
   */
  async recoverIfFailed() {
    if (!this.playerFailed || !this.containerEl) return false;
    const videoId = this.currentVideoId;
    if (!videoId || this.recoveredVideoId === videoId) return false;
    this.recoveredVideoId = videoId;
    this.playerFailed = false;
    this.failedVideoId = null;
    try {
      this.player?.destroy?.();
    } catch {
      // Ignore cleanup error
    }
    this.player = null;
    this.isReady = false;
    this.hasPlayedVideoId = null;
    this.loadIssuedForVideoId = null;
    this.pendingVideo = null;
    this.state = 'idle';
    await this.initialize(this.containerEl);
    return true;
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

    // F1: a previous load may have left the player instance dead — recover
    // it (once per video) before issuing a new load.
    await this.recoverIfFailed();

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
    // F1: recover a dead instance first (once per video), and never re-issue
    // a load for a video that already failed on a FRESH instance — the error
    // banner (with "Play next song") is the way out, not a reload loop.
    await this.recoverIfFailed();
    if (this.currentVideoId && this.hasPlayedVideoId !== this.currentVideoId) {
      if (this.loadIssuedForVideoId === this.currentVideoId) {
        this.player.playVideo();
        return;
      }
      if (
        this.failedVideoId === this.currentVideoId &&
        this.recoveredVideoId === this.currentVideoId
      ) {
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
    this.playerFailed = false;
    this.failedVideoId = null;
    this.recoveredVideoId = null;
  }
}
