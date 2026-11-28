import { BasePlayer } from './BasePlayer.js';

/**
 * Deterministic Web Audio API fixture player for local synchronization testing
 * without third-party API restrictions. Plays gentle harmonic synth pulses.
 */
export class LocalAudioPlayer extends BasePlayer {
  constructor(callbacks = {}) {
    super(callbacks);
    this.audioCtx = null;
    this.gainNode = null;
    this.pulseTimer = null;
    this.state = 'idle'; // 'idle' | 'ready' | 'playing' | 'paused' | 'ended'
    this.durationMs = 180000;
    this.anchorPositionMs = 0;
    this.anchorMonoMs = 0;
    this.track = null;
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
      canSchedule: true,
      backgroundPlayback: false,
    };
  }

  async initialize() {
    if (!this.audioCtx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
        this.gainNode = this.audioCtx.createGain();
        this._applyVolumeToGain();
        this.gainNode.connect(this.audioCtx.destination);
      }
    }
    this.state = 'ready';
    this.callbacks.onReady?.();
  }

  needsAudioGesture() {
    return this.audioCtx?.state === 'suspended';
  }

  async unlockAudio() {
    if (!this.needsAudioGesture()) return true;
    try {
      await this.audioCtx.resume();
      return !this.needsAudioGesture();
    } catch {
      return false;
    }
  }

  _playStepTone() {
    if (!this.audioCtx || !this.gainNode || this.audioCtx.state !== 'running') return;
    const now = this.audioCtx.currentTime;
    const posSec = Math.floor((this.anchorPositionMs + (performance.now() - this.anchorMonoMs)) / 1000);
    const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    const freq = scale[Math.abs(posSec) % scale.length];

    const osc = this.audioCtx.createOscillator();
    const env = this.audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.4, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    osc.connect(env);
    env.connect(this.gainNode);
    osc.start(now);
    osc.stop(now + 0.48);
  }

  _startLoop() {
    this._stopLoop();
    this._playStepTone();
    this.pulseTimer = setInterval(async () => {
      const pos = await this.getPosition();
      if (pos >= this.durationMs) {
        this.state = 'ended';
        this._stopLoop();
        this.callbacks.onStateChange?.('ended');
        this.callbacks.onEnded?.();
        return;
      }
      this._playStepTone();
    }, 1000);
  }

  _stopLoop() {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  _applyVolumeToGain() {
    if (this.gainNode) {
      // Base synth level is 0.06; scale it by the Duet volume (0..1).
      this.gainNode.gain.value = this.muted ? 0 : 0.06 * this.volume;
    }
  }

  setDuration(durationMs) {
    this.durationMs = Math.max(1000, Math.round(durationMs));
  }

  async loadTrack(track, startPositionMs = 0, shouldPlay = false) {
    this._stopLoop();
    this.track = track;
    this.setDuration((track?.durationSec || 180) * 1000);
    this.anchorPositionMs = Math.max(0, Math.min(this.durationMs, startPositionMs));
    this.anchorMonoMs = performance.now();
    this.state = 'paused';
    this.callbacks.onReady?.();
    if (shouldPlay) await this.play();
    else this.callbacks.onStateChange?.('paused');
  }

  async play() {
    this.anchorMonoMs = performance.now();
    this.state = 'playing';
    this._startLoop();
    this.callbacks.onStateChange?.('playing');
  }

  async pause() {
    this.anchorPositionMs = await this.getPosition();
    this.anchorMonoMs = performance.now();
    this.state = 'paused';
    this._stopLoop();
    this.callbacks.onStateChange?.('paused');
  }

  async seek(positionMs) {
    this.anchorPositionMs = Math.max(0, Math.min(this.durationMs, positionMs));
    this.anchorMonoMs = performance.now();
  }

  async getPosition() {
    if (this.state !== 'playing') {
      return this.anchorPositionMs;
    }
    const elapsed = Math.max(0, performance.now() - this.anchorMonoMs);
    return Math.min(this.durationMs, this.anchorPositionMs + elapsed);
  }

  async getDuration() {
    return this.durationMs;
  }

  // The local track actually loaded right now (B1 drift-loop guard).
  async getLoadedVideoId() {
    return this.track?.id || null;
  }

  async getState() {
    return this.state;
  }

  async setVolume(volume01) {
    this.volume = Math.max(0, Math.min(1, Number(volume01) || 0));
    this._applyVolumeToGain();
  }

  async setMuted(muted) {
    this.muted = Boolean(muted);
    this._applyVolumeToGain();
  }

  async getVolume() {
    return this.muted ? 0 : this.volume;
  }

  async destroy() {
    this._stopLoop();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        await this.audioCtx.close();
      } catch {
        // Ignore
      }
    }
    this.audioCtx = null;
  }
}
