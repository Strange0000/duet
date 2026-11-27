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
        this.gainNode.gain.value = 0.06;
        this.gainNode.connect(this.audioCtx.destination);
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch {
        // Requires user gesture
      }
    }
    this.state = 'ready';
    this.callbacks.onReady?.();
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

  async loadTrack(track, startPositionMs = 0) {
    this.track = track;
    this.durationMs = Math.max(1000, Math.round((track?.durationSec || 180) * 1000));
    this.anchorPositionMs = Math.max(0, Math.min(this.durationMs, startPositionMs));
    this.anchorMonoMs = performance.now();
    this.state = 'paused';
    this.callbacks.onReady?.();
  }

  async play() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch {
        // Ignore if gesture not yet unlocked
      }
    }
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

  async getState() {
    return this.state;
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
