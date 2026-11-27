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
  constructor({ ttlMs = 86400000, maxParticipants = 2, hostGraceMs = 30000, guestGraceMs = 60000 } = {}) {
    this.rooms = new Map();
    this.tokenIndex = new Map(); // sessionToken -> { roomCode, participantId }
    this.ttlMs = ttlMs;
    this.maxParticipants = maxParticipants;
    this.hostGraceMs = hostGraceMs;
    this.guestGraceMs = guestGraceMs;
  }

  _now() {
    return Date.now();
  }

  // N-02: a durationMs of 0 means "unknown" (e.g. oEmbed lookup without a
  // YouTube API key). Positions are only clamped when a real duration is known.
  _clampPositionMs(room, positionMs) {
    const durationMs = room.playback.durationMs;
    if (durationMs > 0) return Math.max(0, Math.min(durationMs, positionMs));
    return Math.max(0, positionMs);
  }

  _computeCurrentPositionMs(room, atServerMs = this._now()) {
    const pb = room.playback;
    if (pb.playbackState !== 'playing') {
      return this._clampPositionMs(room, pb.anchorPositionMs);
    }
    const elapsed = Math.max(0, atServerMs - pb.anchorServerTimeMs);
    return this._clampPositionMs(room, pb.anchorPositionMs + elapsed);
  }

  _canControl(room, participant) {
    return Boolean(participant && (participant.role === 'host' || room.settings.allowGuestControl));
  }

  // R7(b): participant names must be distinct within a room, otherwise
  // toasts, presence and chat are ambiguous (two participants both called
  // e.g. "Diana"). If the requested name is already used by another
  // participant — or by a pending join request — append " 2", " 3", …
  // until it is unique. Comparison is case-insensitive. Names are capped
  // at 40 chars by the event validators, so the base is trimmed to leave
  // room for the suffix.
  _uniqueNameInRoom(room, desiredName, excludeParticipantId = null) {
    const base = String(desiredName || 'Guest').trim() || 'Guest';
    const taken = new Set();
    for (const p of room.participants.values()) {
      if (p.id !== excludeParticipantId) taken.add(String(p.name || '').trim().toLowerCase());
    }
    for (const req of room.pendingJoins?.values() || []) {
      taken.add(String(req.name || '').trim().toLowerCase());
    }
    if (!taken.has(base.toLowerCase())) return base;
    const shortBase = base.length > 38 ? base.slice(0, 38).trimEnd() : base;
    let n = 2;
    while (taken.has(`${shortBase} ${n}`.toLowerCase())) n += 1;
    return `${shortBase} ${n}`;
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
      pendingJoins: Array.from((room.pendingJoins || new Map()).values()).map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source,
        requestedAtMs: r.requestedAtMs,
      })),
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
    const durationMs = firstItem?.track?.durationSec
      ? Math.round(firstItem.track.durationSec * 1000)
      : 0;

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
        // R2(c): a two-person app — guest queue adds are ON by default for
        // new rooms; the host can still turn them off in Room settings.
        allowGuestQueue: true,
        allowGuestControl: false,
        requireApproval: false,
        theme: 'midnight',
      },
      pendingJoins: new Map(),
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
        // N-32: nothing has played yet when the room is created.
        tracksPlayed: 0,
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

  requestJoin({ roomCode, name = 'Guest', source = 'youtube', socketId }) {
    const room = this.getRoom(roomCode);
    if (!room) {
      return { error: 'Room not found or expired', code: 'ROOM_NOT_FOUND' };
    }
    if (room.participants.size >= this.maxParticipants) {
      return { error: 'Room is full (maximum 2 participants)', code: 'ROOM_FULL' };
    }
    // Deduplicate by socketId, and by (name + source) for the same room (N-29):
    // a reconnecting guest must not accumulate duplicate pending requests.
    for (const existing of room.pendingJoins.values()) {
      if (
        existing.socketId === socketId ||
        (existing.name === name && existing.source === source)
      ) {
        return { room, request: existing };
      }
    }
    // R7(b): the name shown to the host ("X wants to join") must not
    // collide with a name already in the room.
    name = this._uniqueNameInRoom(room, name);
    const request = {
      id: generateId('req'),
      name,
      source,
      socketId,
      requestedAtMs: this._now(),
    };
    room.pendingJoins.set(request.id, request);
    this._bumpVersion(room);
    return { room, request };
  }

  getPendingJoin(roomCode, requestId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    return room.pendingJoins.get(requestId) || null;
  }

  cancelJoinRequest(roomCode, requestId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    const request = room.pendingJoins.get(requestId);
    if (!request) return null;
    room.pendingJoins.delete(requestId);
    this._bumpVersion(room);
    return { room, request };
  }

  getParticipantBySessionToken(roomCode, sessionToken) {
    if (!sessionToken) return null;
    const indexed = this.tokenIndex.get(sessionToken);
    if (!indexed || indexed.roomCode !== String(roomCode || '').toUpperCase()) return null;
    const room = this.getRoom(indexed.roomCode);
    if (!room) return null;
    return room.participants.get(indexed.participantId) || null;
  }

  respondToJoin(roomCode, participantId, { requestId, approve }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!this._canControl(room, p)) {
      return { error: 'Only the host can respond to join requests', code: 'UNAUTHORIZED' };
    }
    const request = room.pendingJoins.get(requestId);
    if (!request) {
      return { error: 'Join request not found or expired', code: 'NOT_FOUND' };
    }
    room.pendingJoins.delete(requestId);

    if (!approve) {
      this._bumpVersion(room);
      return { room, approved: false, request };
    }

    const joined = this.joinRoom({
      roomCode: room.code,
      name: request.name,
      source: request.source,
    });
    if (joined.error) {
      return { error: joined.error, code: joined.code, request };
    }
    return { room: joined.room, approved: true, request, joined };
  }

  removePendingSocket(socketId) {
    for (const room of this.rooms.values()) {
      for (const [reqId, req] of room.pendingJoins.entries()) {
        if (req.socketId === socketId) {
          room.pendingJoins.delete(reqId);
          this._bumpVersion(room);
          return room;
        }
      }
    }
    return null;
  }

  joinRoom({ roomCode, name = 'Guest', source = 'youtube', sessionToken } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) {
      return { error: 'Room not found or expired', code: 'ROOM_NOT_FOUND' };
    }

    // M4: idempotent rejoin — a sessionToken that already belongs to a
    // participant in this room reuses that slot (e.g. a guest refreshing the
    // page) instead of creating a new participant or hitting ROOM_FULL.
    if (sessionToken) {
      const existing = this.getParticipantBySessionToken(room.code, sessionToken);
      if (existing) {
        existing.connected = true;
        if (existing.guestGraceTimer) {
          clearTimeout(existing.guestGraceTimer);
          existing.guestGraceTimer = null;
        }
        this._bumpVersion(room);
        return {
          room,
          participantId: existing.id,
          sessionToken: existing.sessionToken,
          role: existing.role,
          rejoined: true,
        };
      }
    }

    if (room.participants.size >= this.maxParticipants) {
      return { error: 'Room is full (maximum 2 participants)', code: 'ROOM_FULL' };
    }

    // R7(b): never give two participants in the same room the same name.
    name = this._uniqueNameInRoom(room, name);

    const now = this._now();
    const participantId = generateId('usr');
    const newSessionToken = generateSessionToken();

    room.participants.set(participantId, {
      id: participantId,
      sessionToken: newSessionToken,
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

    this.tokenIndex.set(newSessionToken, { roomCode: room.code, participantId });
    this._bumpVersion(room);

    return {
      room,
      participantId,
      sessionToken: newSessionToken,
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
    // N-15: a reconnect cancels a pending guest-removal timer.
    if (participant.guestGraceTimer) {
      clearTimeout(participant.guestGraceTimer);
      participant.guestGraceTimer = null;
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
    if (p.guestGraceTimer) {
      clearTimeout(p.guestGraceTimer);
      p.guestGraceTimer = null;
    }
    return room;
  }

  markDisconnected(roomCode, participantId, onHostGraceExpired, onGuestRemoved, socketId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    const p = room.participants.get(participantId);
    if (!p) return null;

    // R2(a): ignore a STALE disconnect. When a guest's socket drops and the
    // client reconnects fast, the server only notices the old socket is dead
    // later (heartbeat timeout) — after the participant already re-attached
    // on the new socket via room:reconnect. Marking the participant
    // disconnected then arms the guest grace timer, which 60s later deletes
    // a live participant out from under its connected socket, so every later
    // command fails 'Participant not found'. Only the currently attached
    // socket may mark the participant disconnected. (socketId is optional
    // so older callers / tests without one keep the previous behaviour.)
    if (socketId && p.socketId && p.socketId !== socketId) {
      return null;
    }

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

    // N-15: guests get a grace timer too (60s). If they have not reconnected
    // when it fires, remove them and free their tokenIndex entry so the 2nd
    // slot opens up again. The host is never removed this way.
    if (p.role === 'guest' && !p.guestGraceTimer) {
      p.guestGraceTimer = setTimeout(() => {
        p.guestGraceTimer = null;
        const current = this.getRoom(room.code);
        if (!current) return;
        const guest = current.participants.get(participantId);
        if (!guest || guest.connected) return;
        this.tokenIndex.delete(guest.sessionToken);
        current.participants.delete(participantId);
        this._bumpVersion(current);
        if (onGuestRemoved) onGuestRemoved(current);
      }, this.guestGraceMs);
      // Don't let a pending guest-removal timer hold the process open.
      p.guestGraceTimer.unref?.();
    }

    this._bumpVersion(room);
    return room;
  }

  leaveRoom(roomCode, participantId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    const p = room.participants.get(participantId);
    if (!p) return null;

    if (p.guestGraceTimer) {
      clearTimeout(p.guestGraceTimer);
      p.guestGraceTimer = null;
    }
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
      if (p.guestGraceTimer) {
        clearTimeout(p.guestGraceTimer);
        p.guestGraceTimer = null;
      }
      this.tokenIndex.delete(p.sessionToken);
    }
    this.rooms.delete(code);
    return room;
  }

  // N-02: accept the real track duration reported by a client player
  // (player:duration). Only a duration in range for the track version that is
  // currently playing is accepted; anything else is rejected without change.
  correctTrackDuration(roomCode, participantId, { durationMs, trackVersion } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!p) return { error: 'Participant not found', code: 'PARTICIPANT_NOT_FOUND' };
    if (typeof durationMs !== 'number' || durationMs < 15000 || durationMs > 43200000) {
      return { error: 'Duration must be between 15s and 12h', code: 'INVALID_DURATION' };
    }
    if (trackVersion !== room.playback.trackVersion) {
      return { error: 'Track has changed; duration no longer applies', code: 'VERSION_MISMATCH' };
    }
    room.playback.durationMs = Math.round(durationMs);
    const currentItem = room.queue.find((q) => q.queueItemId === room.currentQueueItemId);
    if (currentItem) {
      currentItem.track.durationSec = durationMs / 1000;
    }
    this._bumpVersion(room);
    return { room };
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

    // R7(b): a rename must not collide with the other participant's name.
    if (name) p.name = this._uniqueNameInRoom(room, name, participantId);
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
    if (!this._canControl(room, p)) return { error: 'Only the host can control playback', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const now = this._now();
    const effectiveAt = now + scheduleLeadMs;
    const anchorPos =
      typeof positionMs === 'number'
        ? this._clampPositionMs(room, positionMs)
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
    if (!this._canControl(room, p)) return { error: 'Only the host can control playback', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const now = this._now();
    const anchorPos =
      typeof positionMs === 'number'
        ? this._clampPositionMs(room, positionMs)
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
    if (!this._canControl(room, p)) return { error: 'Only the host can seek', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const now = this._now();
    const clamped = this._clampPositionMs(room, positionMs);
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
    // N-02: unknown duration (null) stays 0 ("unknown") rather than a fake 210s.
    room.playback.durationMs = queueItem.track.durationSec
      ? Math.round(queueItem.track.durationSec * 1000)
      : 0;
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
    if (!this._canControl(room, p)) return { error: 'Only the host can skip tracks', code: 'UNAUTHORIZED' };

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

    if (!this._canControl(room, p) && !room.settings.allowGuestQueue) {
      // R2(b): distinct code for the disabled case — the client maps this to
      // the honest message, and it must never be confused with a missing
      // participant (which is UNAUTHORIZED / PARTICIPANT_NOT_FOUND).
      return { error: 'Guest queue additions are disabled by the host', code: 'GUEST_QUEUE_DISABLED' };
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
      if (this._canControl(room, p) || !room.currentQueueItemId) {
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
    if (!this._canControl(room, p)) return { error: 'Only the host can remove queued tracks', code: 'UNAUTHORIZED' };

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
    if (!this._canControl(room, p)) return { error: 'Only the host can reorder the queue', code: 'UNAUTHORIZED' };

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
    if (!this._canControl(room, p)) return { error: 'Only the host can select tracks', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    const item = room.queue.find((q) => q.queueItemId === queueItemId);
    if (!item) return { error: 'Queue item not found', code: 'NOT_FOUND' };

    this._selectQueueItemInternal(room, item, true);
    this._bumpVersion(room, commandId);
    return { room };
  }

  updateSettings(roomCode, participantId, { allowGuestQueue, allowGuestControl, requireApproval, theme, commandId, expectedRoomVersion }) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!this._canControl(room, p)) return { error: 'Only the host can update room settings', code: 'UNAUTHORIZED' };

    const check = this._isDuplicateOrStale(room, commandId, expectedRoomVersion);
    if (check.skip) return { room, skipped: check.reason };

    if (typeof allowGuestQueue === 'boolean') room.settings.allowGuestQueue = allowGuestQueue;
    if (typeof allowGuestControl === 'boolean') room.settings.allowGuestControl = allowGuestControl;
    if (typeof requireApproval === 'boolean') room.settings.requireApproval = requireApproval;
    if (theme) room.settings.theme = theme;
    this._bumpVersion(room, commandId);
    return { room };
  }

  clearQueue(roomCode, participantId, { commandId, expectedRoomVersion } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };
    const p = room.participants.get(participantId);
    if (!this._canControl(room, p)) return { error: 'Only the host can clear the queue', code: 'UNAUTHORIZED' };

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
