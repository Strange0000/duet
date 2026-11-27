export class BasePlayer {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
  }

  async initialize(_containerEl) {}
  async loadTrack(_track, _startPositionMs = 0, _shouldPlay = false) {}
  async play() {}
  async pause() {}
  async seek(_positionMs) {}
  async getPosition() {
    return 0;
  }
  async getDuration() {
    return 0;
  }
  // Identifier of the media actually loaded in the player right now, or
  // null when unknown. The drift loop uses this to avoid seeking a player
  // that is still on the previous track while a new one loads (B1).
  async getLoadedVideoId() {
    return null;
  }
  async getState() {
    return 'idle';
  }
  async setVolume(_volume01) {}
  async setMuted(_muted) {}
  async getVolume() {
    return 1;
  }
  async destroy() {}

  getCapabilities() {
    return {
      canSeek: false,
      canAdjustSpeed: false,
      canReportPosition: false,
      requiresGesture: true,
      hasNativeControls: false,
      canSchedule: false,
      backgroundPlayback: false,
    };
  }
}
