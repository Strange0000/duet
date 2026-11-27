import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_QUEUE_SIZE = 100;
const MAX_CHAT_MESSAGES = 100;
const MAX_COMMAND_HISTORY = 250;

export function generateSecureRoomCode(existingCheck) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    if (!existingCheck || !existingCheck(code)) {
      return code;
    }
  }
  throw new Error('Failed to generate unique room code');
}

export function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export class RoomStore {
  constructor({ ttlMs = 86400000, maxParticipants = 2, hostGraceMs = 30000 } = {}) {
    this.rooms = new Map();
    this.tokenIndex = new Map(); // sessionToken -> { roomCode, participantId }
    this.ttlMs = ttlMs;
    this.maxParticipants = maxParticipants;
    this.hostGraceMs = hostGraceMs;
  }

  _now() {
    return Date.now();
  }

  _computeCurrentPositionMs(room, atServerMs = this._now()) {
    const pb = room.playback;
    if (pb.playbackState !== 'playing') {
      return Math.max(0, Math.min(pb.durationMs, pb.anchorPositionMs));
    }
    const elapsed = Math.max(0, atServerMs - pb.anchorServerTimeMs);
    return Math.max(0, Math.min(pb.durationMs, pb.anchorPositionMs + elapsed));
  }

  _deriveLifecycleState(room) {
    if (room.closed) return 'Room closed';
    if (this._now() > room.expiresAtMs) return 'Room expired';

    const participants = Array.from(room.participants.values());
    const connected = participants.filter((p) => p.connected);
    const host = participants.find((p) => p.role === 'host');

    if (connected.length === 0) return 'Reconnecting';
    if (participants.length < 2) return 'Waiting for partner';
    if (!host?.connected || connected.length < 2) return 'Partner disconnected';
    if (connected.some((p) => p.buffering)) return 'Buffering';
    if (connected.some((p) => !p.ready)) return 'Waiting for playback readiness';
    if (room.playback.playbackState === 'playing') return 'Playing';
    if (room.playback.playbackState === 'paused') return 'Paused';
    return 'Both connected';
  }

  _bumpVersion(room, commandId) {
    room.roomVersion += 1;
    room.playback.roomVersion = room.roomVersion;
    room.updatedAtMs = this._now();
    if (commandId) {
      room.processedCommands.add(commandId);
      if (room.processedCommands.size > MAX_COMMAND_HISTORY) {
        const first = room.processedCommands.values().next().value;
        room.processedCommands.delete(first);
      }
    }
  }

  _isDuplicateOrStale(room, commandId, expectedRoomVersion) {
    if (commandId && room.processedCommands.has(commandId)) {
      return { skip: true, reason: 'duplicate_command' };
    }
    if (
      typeof expectedRoomVersion === 'number' &&
      expectedRoomVersion < room.roomVersion
    ) {
      return { skip: true, reason: 'stale_version' };
    }
    return { skip: false };
  }

  serializeRoom(room) {
    const participants = Array.from(room.participants.values()).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      source: p.source,
      connected: p.connected,
      ready: p.ready,
      buffering: p.buffering,
      reportedPositionMs: p.reportedPositionMs,
      driftMs: p.driftMs,
      joinedAtMs: p.joinedAtMs,
    }));

    return {
      roomCode: room.code,
      lifecycleState: this._deriveLifecycleState(room),
      roomVersion: room.roomVersion,
      createdAtMs: room.createdAtMs,
      expiresAtMs: room.expiresAtMs,
      settings: { ...room.settings },
      playback: { ...room.playback },
      queue: room.queue.map((item) => ({ ...item })),
      currentQueueItemId: room.currentQueueItemId,
      participants,
      chat: room.chat.slice(-MAX_CHAT_MESSAGES),
      stats: {
        tracksPlayed: room.stats.tracksPlayed,
      },
    };
  }

  createRoom({ name = 'Host', source = 'youtube', initialTracks = [] } = {}) {
    const code = generateSecureRoomCode((c) => this.rooms.has(c));
    const now = this._now();
    const participantId = generateId('usr');
    const sessionToken = generateSessionToken();

    const queue = initialTracks.slice(0, MAX_QUEUE_SIZE).map((t) => ({
      queueItemId: generateId('qi'),
      addedBy: participantId,
      addedByName: name,
      addedAtMs: now,
      track: { ...t },
    }));

    const firstItem = queue[0] || null;
    const durationMs = firstItem ? Math.round(firstItem.track.durationSec * 1000) : 0;

    const room = {
      code,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.ttlMs,
      closed: false,
      roomVersion: 1,
      hostGraceTimer: null,
      processedCommands: new Set(),
      settings: {
        allowGuestQueue: false,
        theme: 'midnight',
      },
      participants: new Map([
        [
          participantId,
          {
            id: participantId,
            sessionToken,
            name,
            role: 'host',
            source,
            connected: true,
            socketId: null,
            ready: false,
            buffering: false,
            reportedPositionMs: 0,
            driftMs: 0,
            joinedAtMs: now,
          },
        ],
      ]),
      queue,
      currentQueueItemId: firstItem ? firstItem.queueItemId : null,
      playback: {
        roomCode: code,
        trackId: firstItem ? firstItem.track.id : null,
        trackVersion: firstItem ? 1 : 0,
        playbackState: 'paused',
        anchorPositionMs: 0,
        anchorServerTimeMs: now,
        effectiveAtServerMs: now,
        durationMs,
        roomVersion: 1,
      },
      chat: [],
      stats: {
        tracksPlayed: firstItem ? 1 : 0,
      },
    };

    this.rooms.set(code, room);
    this.tokenIndex.set(sessionToken, { roomCode: code, participantId });

    return {
      room,
      participantId,
      sessionToken,
      role: 'host',
    };
  }

  getRoom(roomCode) {
    const code = String(roomCode || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.closed || this._now() > room.expiresAtMs) {
      this.closeRoom(code);
      return null;
    }
    return room;
  }

  joinRoom({ roomCode, name = 'Guest', source = 'youtube' }) {
    const room = this.getRoom(roomCode);
    if (!room) {
      return { error: 'Room not found or expired', code: 'ROOM_NOT_FOUND' };
    }

    if (room.participants.size >= this.maxParticipants) {
      return { error: 'Room is full (maximum 2 participants)', code: 'ROOM_FULL' };
    }

    const now = this._now();
    const participantId = generateId('usr');
    const sessionToken = generateSessionToken();

    room.participants.set(participantId, {
      id: participantId,
      sessionToken,
      name,
      role: 'guest',
      source,
      connected: true,
      socketId: null,
      ready: false,
      buffering: false,
      reportedPositionMs: 0,
      driftMs: 0,
      joinedAtMs: now,
    });

    this.tokenIndex.set(sessionToken, { roomCode: room.code, participantId });
    this._bumpVersion(room);

    return {
      room,
      participantId,
      sessionToken,
      role: 'guest',
    };
  }

  reconnect({ roomCode, sessionToken }) {
    const indexed = this.tokenIndex.get(sessionToken);
    if (!indexed || indexed.roomCode !== String(roomCode || '').toUpperCase()) {
      return { error: 'Invalid or expired session token', code: 'INVALID_SESSION' };
    }

    const room = this.getRoom(indexed.roomCode);
    if (!room) {
      return { error: 'Room not found or expired', code: 'ROOM_NOT_FOUND' };
    }

    const participant = room.participants.get(indexed.participantId);
    if (!participant) {
      return { error: 'Participant no longer in room', code: 'PARTICIPANT_NOT_FOUND' };
    }

    participant.connected = true;
    if (participant.role === 'host' && room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }

    this._bumpVersion(room);
    return {
      room,
      participantId: participant.id,
      sessionToken: participant.sessionToken,
      role: participant.role,
    };
  }

  attachSocket(roomCode, participantId, socketId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    const p = room.participants.get(participantId);
    if (!p) return null;
    p.socketId = socketId;
    p.connected = true;
    if (p.role === 'host' && room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    return room;
  }

  markDisconnected(roomCode, participantId, onHostGraceExpired) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    const p = room.participants.get(participantId);
    if (!p) return null;

    p.connected = false;
    p.socketId = null;

    if (p.role === 'host' && !room.hostGraceTimer) {
      room.hostGraceTimer = setTimeout(() => {
        const current = this.getRoom(room.code);
        if (!current) return;
        const host = current.participants.get(participantId);
        if (host && !host.connected && current.playback.playbackState === 'playing') {
          const now = this._now();
          current.playback.anchorPositionMs = this._computeCurrentPositionMs(current, now);
          current.playback.anchorServerTimeMs = now;
          current.playback.effectiveAtServerMs = now;
          current.playback.playbackState = 'paused';
          this._bumpVersion(current);
          if (onHostGraceExpired) onHostGraceExpired(current);
        }
      }, this.hostGraceMs);
    }

    this._bumpVersion(room);
    return room;
  }

  leaveRoom(roomCode, participantId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    const p = room.participants.get(participantId);
    if (!p) return null;

    this.tokenIndex.delete(p.sessionToken);
    room.participants.delete(participantId);

    if (p.role === 'host') {
      if (room.hostGraceTimer) {
        clearTimeout(room.hostGraceTimer);
        room.hostGraceTimer = null;
      }
      // If a guest remains, promote only if explicit or close room
      this.closeRoom(room.code);
      return { roomClosed: true, room };
    }

    this._bumpVersion(room);
    return { roomClosed: false, room };
  }

  closeRoom(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return null;
    room.closed = true;
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    for (const p of room.participants.values()) {
      this.tokenIndex.delete(p.sessionToken);
    }
    this.rooms.delete(code);
    return room;
  }

  transferHost(roomCode, currentHostId, targetParticipantId, commandId, expectedRoomVersion) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };

    const host = room.participants.get(currentHostId);
    if (!host || host.role !== 'host') {
      return { error: 'Only the host can transfer ownership', code: 'UNAUTHORIZED' };
    }

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const target = room.participants.get(targetParticipantId);
    if (!target || target.id === host.id) {
      return { error: 'Target participant not found', code: 'TARGET_NOT_FOUND' };
    }

    host.role = 'guest';
    target.role = 'host';
    this._bumpVersion(room, commandId);
    return { room };
  }

  updateParticipant(roomCode, participantId, { name, source }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p) return { error: 'Participant not found', code: 'PARTICIPANT_NOT_FOUND' };

    if (name) p.name = name;
    if (source) {
      p.source = source;
      p.ready = false;
    }
    this._bumpVersion(room);
    return { room, participant: p };
  }

  updatePlayerStatus(roomCode, participantId, status) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p) return { error: 'Participant not found', code: 'PARTICIPANT_NOT_FOUND' };

    if (typeof status.ready === 'boolean') p.ready = status.ready;
    if (typeof status.buffering === 'boolean') p.buffering = status.buffering;
    if (typeof status.reportedPositionMs === 'number') p.reportedPositionMs = status.reportedPositionMs;
    if (typeof status.driftMs === 'number') p.driftMs = status.driftMs;

    let autoAdvanced = false;
    if (
      typeof status.endedTrackVersion === 'number' &&
      status.endedTrackVersion === room.playback.trackVersion &&
      room.playback.playbackState === 'playing'
    ) {
      // Single-advance protection: advance only once for this trackVersion
      const adv = this._advanceTrackInternal(room, 1);
      autoAdvanced = adv.changed;
    }

    return { room, participant: p, autoAdvanced };
  }

  play(roomCode, participantId, { positionMs, scheduleLeadMs = 0, commandId, expectedRoomVersion } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can control playback', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const now = this._now();
    const effectiveAt = now + scheduleLeadMs;
    const anchorPos =
      typeof positionMs === 'number'
        ? Math.max(0, Math.min(room.playback.durationMs, positionMs))
        : this._computeCurrentPositionMs(room, now);

    room.playback.playbackState = 'playing';
    room.playback.anchorPositionMs = anchorPos;
    room.playback.anchorServerTimeMs = effectiveAt;
    room.playback.effectiveAtServerMs = effectiveAt;

    this._bumpVersion(room, commandId);
    return { room, scheduled: scheduleLeadMs > 0 };
  }

  pause(roomCode, participantId, { positionMs, commandId, expectedRoomVersion } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can control playback', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const now = this._now();
    const anchorPos =
      typeof positionMs === 'number'
        ? Math.max(0, Math.min(room.playback.durationMs, positionMs))
        : this._computeCurrentPositionMs(room, now);

    room.playback.playbackState = 'paused';
    room.playback.anchorPositionMs = anchorPos;
    room.playback.anchorServerTimeMs = now;
    room.playback.effectiveAtServerMs = now;

    this._bumpVersion(room, commandId);
    return { room };
  }

  seek(roomCode, participantId, { positionMs, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can seek', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const now = this._now();
    const clamped = Math.max(0, Math.min(room.playback.durationMs, positionMs));
    room.playback.anchorPositionMs = clamped;
    room.playback.anchorServerTimeMs = now;
    room.playback.effectiveAtServerMs = now;

    this._bumpVersion(room, commandId);
    return { room };
  }

  _selectQueueItemInternal(room, queueItem, autoPlay = true) {
    const now = this._now();
    room.currentQueueItemId = queueItem.queueItemId;
    room.playback.trackId = queueItem.track.id;
    room.playback.trackVersion += 1;
    room.playback.durationMs = Math.round(queueItem.track.durationSec * 1000);
    room.playback.anchorPositionMs = 0;
    room.playback.anchorServerTimeMs = now;
    room.playback.effectiveAtServerMs = now;
    room.playback.playbackState = autoPlay ? 'playing' : 'paused';
    room.stats.tracksPlayed += 1;
    for (const p of room.participants.values()) {
      p.reportedPositionMs = 0;
      p.driftMs = 0;
    }
  }

  _advanceTrackInternal(room, delta) {
    if (room.queue.length === 0) return { changed: false };
    const idx = room.queue.findIndex((q) => q.queueItemId === room.currentQueueItemId);
    const currentIdx = idx === -1 ? 0 : idx;
    const nextIdx = (currentIdx + delta + room.queue.length) % room.queue.length;
    this._selectQueueItemInternal(room, room.queue[nextIdx], true);
    this._bumpVersion(room);
    return { changed: true };
  }

  stepTrack(roomCode, participantId, delta, { commandId, expectedRoomVersion } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can skip tracks', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    this._advanceTrackInternal(room, delta);
    if (commandId) room.processedCommands.add(commandId);
    return { room };
  }

  addToQueue(roomCode, participantId, { track, playNow = false, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p) return { error: 'Participant not found', code: 'PARTICIPANT_NOT_FOUND' };

    if (p.role !== 'host' && !room.settings.allowGuestQueue) {
      return { error: 'Guest queue additions are disabled by the host', code: 'UNAUTHORIZED' };
    }

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    if (room.queue.length >= MAX_QUEUE_SIZE) {
      return { error: 'Queue limit reached (100 tracks)', code: 'QUEUE_FULL' };
    }

    const item = {
      queueItemId: generateId('qi'),
      addedBy: p.id,
      addedByName: p.name,
      addedAtMs: this._now(),
      track: { ...track },
    };

    room.queue.push(item);

    if (playNow || !room.currentQueueItemId) {
      if (p.role === 'host' || !room.currentQueueItemId) {
        this._selectQueueItemInternal(room, item, playNow);
      }
    }

    this._bumpVersion(room, commandId);
    return { room, addedItem: item };
  }

  removeFromQueue(roomCode, participantId, { queueItemId, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can remove queued tracks', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const idx = room.queue.findIndex((q) => q.queueItemId === queueItemId);
    if (idx === -1) return { error: 'Queue item not found', code: 'NOT_FOUND' };

    const wasCurrent = room.currentQueueItemId === queueItemId;
    room.queue.splice(idx, 1);

    if (wasCurrent) {
      if (room.queue.length > 0) {
        const nextItem = room.queue[Math.min(idx, room.queue.length - 1)];
        this._selectQueueItemInternal(room, nextItem, room.playback.playbackState === 'playing');
      } else {
        room.currentQueueItemId = null;
        room.playback.trackId = null;
        room.playback.trackVersion += 1;
        room.playback.playbackState = 'paused';
        room.playback.anchorPositionMs = 0;
        room.playback.durationMs = 0;
      }
    }

    this._bumpVersion(room, commandId);
    return { room };
  }

  reorderQueue(roomCode, participantId, { fromIndex, toIndex, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can reorder the queue', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= room.queue.length ||
      toIndex >= room.queue.length
    ) {
      return { error: 'Invalid queue indices', code: 'INVALID_INDICES' };
    }

    const [moved] = room.queue.splice(fromIndex, 1);
    room.queue.splice(toIndex, 0, moved);
    this._bumpVersion(room, commandId);
    return { room };
  }

  selectQueueItem(roomCode, participantId, { queueItemId, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can select tracks', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const item = room.queue.find((q) => q.queueItemId === queueItemId);
    if (!item) return { error: 'Queue item not found', code: 'NOT_FOUND' };

    this._selectQueueItemInternal(room, item, true);
    this._bumpVersion(room, commandId);
    return { room };
  }

  updateSettings(roomCode, participantId, { allowGuestQueue, theme, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can update room settings', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    if (typeof allowGuestQueue === 'boolean') room.settings.allowGuestQueue = allowGuestQueue;
    if (theme) room.settings.theme = theme;
    this._bumpVersion(room, commandId);
    return { room };
  }

  clearQueue(roomCode, participantId, { commandId, expectedRoomVersion } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p || p.role !== 'host') return { error: 'Only the host can clear the queue', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    room.queue = [];
    room.currentQueueItemId = null;
    room.playback.trackId = null;
    room.playback.trackVersion += 1;
    room.playback.playbackState = 'paused';
    room.playback.anchorPositionMs = 0;
    room.playback.durationMs = 0;
    const now = this._now();
    room.playback.anchorServerTimeMs = now;
    room.playback.effectiveAtServerMs = now;

    this._bumpVersion(room, commandId);
    return { room };
  }

  addChatMessage(roomCode, participantId, text) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p) return { error: 'Participant not found', code: 'PARTICIPANT_NOT_FOUND' };

    const msg = {
      id: generateId('msg'),
      senderId: p.id,
      senderName: p.name,
      senderRole: p.role,
      text,
      sentAtMs: this._now(),
    };
    room.chat.push(msg);
    if (room.chat.length > MAX_CHAT_MESSAGES) {
      room.chat.shift();
    }
    return { room, message: msg };
  }

  cleanupExpired() {
    const now = this._now();
    let removed = 0;
    for (const [code, room] of this.rooms.entries()) {
      if (room.closed || now > room.expiresAtMs) {
        this.closeRoom(code);
        removed += 1;
      }
    }
    return removed;
  }
}
