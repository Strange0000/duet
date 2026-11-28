import {
  chatSendSchema,
  commandSchema,
  createRoomSchema,
  joinRespondSchema,
  joinRoomSchema,
  participantUpdateSchema,
  playerDurationSchema,
  playerPauseSchema,
  playerPlaySchema,
  playerSeekSchema,
  playerStatusSchema,
  queueAddSchema,
  queueRemoveSchema,
  queueReorderSchema,
  queueSelectSchema,
  reactionSendSchema,
  reconnectRoomSchema,
  roomSettingsSchema,
  syncPingSchema,
  transferHostSchema,
} from '../validators/events.js';

function reply(ack, payload) {
  if (typeof ack === 'function') {
    ack(payload);
  }
}

function validate(schema, raw) {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid payload',
    };
  }
  return { ok: true, data: parsed.data };
}

export function registerSocketHandlers(io, store, env) {
  // N-12: rate limiters keyed by participantId live at SERVER level (not in
  // the per-connection closure) so a reconnect does not reset them. A limiter
  // is created on first use for a participantId + event kind and reused across
  // reconnects. (room:create / room:join run before any participantId exists,
  // so those two stay per-connection; see below.)
  const createSlidingWindowLimiter = (limit) => {
    let attempts = 0;
    let lastReset = Date.now();
    return () => {
      const now = Date.now();
      if (now - lastReset > 60000) {
        attempts = 0;
        lastReset = now;
      }
      attempts += 1;
      return attempts <= limit;
    };
  };
  const participantLimiters = new Map(); // participantId -> Map<kind, limiter>
  // E-18: IP-level rate limiters for pre-membership events (room:create,
  // room:join) so a reconnect does not reset the limiter.
  const ipLimiterMap = new Map(); // IP -> { join, create }
  // I-05: transient socket disconnects (refresh, network switch) reconnect
  // within 1-2s. We delay emitting connection:status { connected: false } by 2s;
  // if room:reconnect or room:join lands within this window, the timer is
  // cancelled and the partner's presence indicator never flashes disconnected.
  const disconnectPresenceTimers = new Map(); // `${roomCode}:${participantId}` -> timer
  const clearDisconnectTimer = (roomCode, participantId) => {
    const key = `${roomCode}:${participantId}`;
    const timer = disconnectPresenceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      disconnectPresenceTimers.delete(key);
    }
  };
  const checkParticipantLimit = (participantId, kind, limit) => {
    let byKind = participantLimiters.get(participantId);
    if (!byKind) {
      if (participantLimiters.size > 5000) {
        participantLimiters.delete(participantLimiters.keys().next().value);
      }
      byKind = new Map();
      participantLimiters.set(participantId, byKind);
    }
    let limiter = byKind.get(kind);
    if (!limiter) {
      limiter = createSlidingWindowLimiter(limit);
      byKind.set(kind, limiter);
    }
    return limiter();
  };

  io.on('connection', (socket) => {
    socket.data.roomCode = null;
    socket.data.participantId = null;

    // Pre-membership limiters: no participantId exists yet when a socket
    // creates or joins a room. E-18: key by IP address instead of per-
    // connection so a reconnect does not reset the limiter. Falls back to
    // the socket id when the IP is unavailable (direct connection / tests).
    const clientIp =
      socket.handshake?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
      socket.handshake?.address ||
      socket.id;
    let ipLimiters = ipLimiterMap.get(clientIp);
    if (!ipLimiters) {
      if (ipLimiterMap.size > 10000) {
        ipLimiterMap.delete(ipLimiterMap.keys().next().value);
      }
      ipLimiters = {
        join: createSlidingWindowLimiter(15),
        create: createSlidingWindowLimiter(10),
      };
      ipLimiterMap.set(clientIp, ipLimiters);
    }
    const checkJoinRateLimit = ipLimiters.join;
    const checkCreateRateLimit = ipLimiters.create;
    const rateLimited = (ack, what) =>
      reply(ack, { ok: false, code: 'RATE_LIMITED', error: `Too many ${what}. Please wait a minute.` });

    const emitRoomState = (room) => {
      io.to(room.code).emit('room:state', store.serializeRoom(room));
    };

    const requireMembership = (ack) => {
      const { roomCode, participantId } = socket.data;
      if (!roomCode || !participantId) {
        reply(ack, { ok: false, code: 'NOT_IN_ROOM', error: 'Not joined to a room' });
        return null;
      }
      const room = store.getRoom(roomCode);
      if (!room) {
        reply(ack, { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found or expired' });
        return null;
      }
      const participant = room.participants.get(participantId);
      if (!participant) {
        reply(ack, { ok: false, code: 'UNAUTHORIZED', error: 'Participant not found' });
        return null;
      }
      return { room, participant };
    };

    // ——— Clock Synchronization ———
    socket.on('sync:ping', (raw, ack) => {
      const v = validate(syncPingSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const serverReceivedAtMs = Date.now();
      const pongPayload = {
        clientSentAtMs: v.data.clientSentAtMs,
        serverReceivedAtMs,
        serverSentAtMs: Date.now(),
        seq: v.data.seq ?? 0,
      };
      socket.emit('sync:pong', pongPayload);
      reply(ack, { ok: true, ...pongPayload });
    });

    socket.on('sync:request', (_raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const state = store.serializeRoom(ctx.room);
      socket.emit('playback:state', state.playback);
      reply(ack, { ok: true, state });
    });

    // ——— Room Lifecycle ———
    socket.on('room:create', (raw, ack) => {
      if (!checkCreateRateLimit()) return rateLimited(ack, 'rooms created');
      const v = validate(createRoomSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      if (v.data.source === 'spotify' && !env.ENABLE_SPOTIFY) {
        v.data.source = 'youtube';
      }

      const created = store.createRoom(v.data);
      socket.data.roomCode = created.room.code;
      socket.data.participantId = created.participantId;
      socket.join(created.room.code);
      // N-04: attach the host's socket at creation so the participant has a
      // socketId from the start (previously null until a later join/reconnect).
      store.attachSocket(created.room.code, created.participantId, socket.id);

      const serialized = store.serializeRoom(created.room);
      const result = {
        ok: true,
        roomCode: created.room.code,
        participantId: created.participantId,
        sessionToken: created.sessionToken,
        role: created.role,
        state: serialized,
      };
      socket.emit('room:created', result);
      reply(ack, result);
    });

    socket.on('room:join', (raw, ack) => {
      if (!checkJoinRateLimit()) {
        return reply(ack, {
          ok: false,
          code: 'RATE_LIMITED',
          error: 'Too many join attempts. Please wait a minute.',
        });
      }

      const v = validate(joinRoomSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      if (v.data.source === 'spotify' && !env.ENABLE_SPOTIFY) {
        v.data.source = 'youtube';
      }

      const targetRoom = store.getRoom(v.data.roomCode);
      // M4: a returning participant (valid sessionToken for this room) rejoins
      // directly — they already passed approval once, and room:join must not
      // route them through a fresh pending request or ROOM_FULL.
      const returningParticipant =
        v.data.sessionToken && targetRoom
          ? store.getParticipantBySessionToken(targetRoom.code, v.data.sessionToken)
          : null;
      if (targetRoom?.settings?.requireApproval && !returningParticipant) {
        const reqRes = store.requestJoin({ ...v.data, socketId: socket.id });
        if (reqRes.error) {
          socket.emit('room:error', { code: reqRes.code, error: reqRes.error });
          return reply(ack, { ok: false, code: reqRes.code, error: reqRes.error });
        }
        io.to(reqRes.room.code).emit('room:join-request', {
          id: reqRes.request.id,
          name: reqRes.request.name,
          source: reqRes.request.source,
          requestedAtMs: reqRes.request.requestedAtMs,
        });
        emitRoomState(reqRes.room);
        return reply(ack, {
          ok: true,
          pendingApproval: true,
          roomCode: reqRes.room.code,
          requestId: reqRes.request.id,
        });
      }

      const joined = store.joinRoom(v.data);
      if (joined.error) {
        socket.emit('room:error', { code: joined.code, error: joined.error });
        return reply(ack, { ok: false, code: joined.code, error: joined.error });
      }

      store.attachSocket(joined.room.code, joined.participantId, socket.id);
      clearDisconnectTimer(joined.room.code, joined.participantId);
      socket.data.roomCode = joined.room.code;
      socket.data.participantId = joined.participantId;
      socket.join(joined.room.code);

      const serialized = store.serializeRoom(joined.room);
      const result = {
        ok: true,
        roomCode: joined.room.code,
        participantId: joined.participantId,
        sessionToken: joined.sessionToken,
        role: joined.role,
        state: serialized,
      };
      socket.emit('room:joined', result);
      socket.to(joined.room.code).emit('participant:joined', {
        participant: serialized.participants.find((p) => p.id === joined.participantId),
      });
      emitRoomState(joined.room);
      reply(ack, result);
    });

    socket.on('room:join-respond', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(joinRespondSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      // N-05: when approving, check the guest socket is still connected
      // BEFORE joining. Approving after the guest dropped used to create a
      // ghost participant (sessionToken never delivered, slot bricked).
      if (v.data.approve) {
        const pending = store.getPendingJoin(ctx.room.code, v.data.requestId);
        if (!pending) {
          return reply(ack, { ok: false, code: 'NOT_FOUND', error: 'Join request not found or expired' });
        }
        const guestSocket = pending.socketId ? io.sockets.sockets.get(pending.socketId) : null;
        if (!guestSocket) {
          store.cancelJoinRequest(ctx.room.code, v.data.requestId);
          emitRoomState(ctx.room);
          return reply(ack, {
            ok: false,
            code: 'GUEST_DISCONNECTED',
            error: 'Guest disconnected — ask them to rejoin',
          });
        }
      }

      const res = store.respondToJoin(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const guestSocket = res.request?.socketId ? io.sockets.sockets.get(res.request.socketId) : null;

      if (res.approved && res.joined) {
        if (guestSocket) {
          store.attachSocket(res.room.code, res.joined.participantId, guestSocket.id);
          guestSocket.data.roomCode = res.room.code;
          guestSocket.data.participantId = res.joined.participantId;
          guestSocket.join(res.room.code);
        }
        const serialized = store.serializeRoom(res.room);
        const result = {
          ok: true,
          roomCode: res.room.code,
          participantId: res.joined.participantId,
          sessionToken: res.joined.sessionToken,
          role: res.joined.role,
          state: serialized,
        };
        if (guestSocket) {
          guestSocket.emit('room:joined', result);
        }
        io.to(res.room.code).emit('participant:joined', {
          participant: serialized.participants.find((p) => p.id === res.joined.participantId),
        });
        emitRoomState(res.room);
        return reply(ack, { ok: true, approved: true, state: serialized });
      }

      if (guestSocket) {
        guestSocket.emit('room:join-declined', {
          roomCode: res.room.code,
          error: 'Host declined your join request',
        });
      }
      emitRoomState(res.room);
      reply(ack, { ok: true, approved: false, state: store.serializeRoom(res.room) });
    });

    socket.on('room:reconnect', (raw, ack) => {
      const v = validate(reconnectRoomSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const rec = store.reconnect(v.data);
      if (rec.error) {
        return reply(ack, { ok: false, code: rec.code, error: rec.error });
      }

      store.attachSocket(rec.room.code, rec.participantId, socket.id);
      clearDisconnectTimer(rec.room.code, rec.participantId);
      socket.data.roomCode = rec.room.code;
      socket.data.participantId = rec.participantId;
      socket.join(rec.room.code);

      const serialized = store.serializeRoom(rec.room);
      const result = {
        ok: true,
        roomCode: rec.room.code,
        participantId: rec.participantId,
        sessionToken: rec.sessionToken,
        role: rec.role,
        state: serialized,
      };
      socket.emit('room:joined', result);
      emitRoomState(rec.room);
      reply(ack, result);
    });

    socket.on('room:leave', (_raw, ack) => {
      const { roomCode, participantId } = socket.data;
      if (!roomCode || !participantId) return reply(ack, { ok: true });

      clearDisconnectTimer(roomCode, participantId);
      const res = store.leaveRoom(roomCode, participantId);
      socket.leave(roomCode);
      socket.data.roomCode = null;
      socket.data.participantId = null;

      if (res?.roomClosed) {
        io.to(roomCode).emit('room:closed', { reason: 'Host left the room' });
      } else if (res?.room) {
        io.to(roomCode).emit('participant:left', { participantId });
        emitRoomState(res.room);
      }
      reply(ack, { ok: true });
    });

    socket.on('room:close', (_raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      if (ctx.participant.role !== 'host') {
        return reply(ack, { ok: false, code: 'UNAUTHORIZED', error: 'Only the host can close the room' });
      }
      const code = ctx.room.code;
      store.closeRoom(code);
      io.to(code).emit('room:closed', { reason: 'Host ended the session' });
      reply(ack, { ok: true });
    });

    socket.on('room:transfer-host', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(transferHostSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.transferHost(
        ctx.room.code,
        ctx.participant.id,
        v.data.targetParticipantId,
        v.data.commandId,
        v.data.expectedRoomVersion
      );
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });
      emitRoomState(res.room);
      reply(ack, { ok: true, state: store.serializeRoom(res.room) });
    });

    socket.on('room:settings', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(roomSettingsSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.updateSettings(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });
      emitRoomState(res.room);
      reply(ack, { ok: true, state: store.serializeRoom(res.room) });
    });

    // ——— Participant Updates ———
    socket.on('participant:update', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(participantUpdateSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      if (v.data.source === 'spotify' && !env.ENABLE_SPOTIFY) {
        return reply(ack, {
          ok: false,
          code: 'PROVIDER_UNAVAILABLE',
          error: 'Spotify playback is currently disabled pending developer policy authorization.',
        });
      }

      const res = store.updateParticipant(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      io.to(ctx.room.code).emit('participant:updated', {
        participant: serialized.participants.find((p) => p.id === ctx.participant.id),
      });
      emitRoomState(res.room);
      reply(ack, { ok: true, state: serialized });
    });

    // ——— Player Status & Transport Controls ———
    socket.on('player:ready', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const res = store.updatePlayerStatus(ctx.room.code, ctx.participant.id, {
        ready: raw?.ready !== false,
      });
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });
      emitRoomState(res.room);
      reply(ack, { ok: true });
    });

    socket.on('player:status', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(playerStatusSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.updatePlayerStatus(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      if (res.autoAdvanced) {
        const serialized = store.serializeRoom(res.room);
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
      }
      emitRoomState(res.room);
      reply(ack, { ok: true });
    });

    // N-02: client reports the real duration from player.getDuration() once a
    // track starts playing; the server corrects an unknown (oEmbed) duration.
    socket.on('player:duration', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(playerDurationSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.correctTrackDuration(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      io.to(ctx.room.code).emit('playback:state', serialized.playback);
      emitRoomState(res.room);
      reply(ack, { ok: true, playback: serialized.playback, state: serialized });
    });

    socket.on('player:play', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(playerPlaySchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.play(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        if (res.scheduled) {
          io.to(ctx.room.code).emit('playback:scheduled', serialized.playback);
        } else {
          io.to(ctx.room.code).emit('playback:state', serialized.playback);
        }
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, playback: serialized.playback, skipped: res.skipped });
    });

    socket.on('player:pause', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(playerPauseSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.pause(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, playback: serialized.playback, skipped: res.skipped });
    });

    socket.on('player:seek', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      // N-06: scrubber drags can spam seeks — 10/min per participant (N-12:
      // server-level limiter, survives reconnects).
      if (!checkParticipantLimit(ctx.participant.id, 'seek', 10)) {
        return rateLimited(ack, 'seeks');
      }
      const v = validate(playerSeekSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.seek(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, playback: serialized.playback, skipped: res.skipped });
    });

    socket.on('player:next', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(commandSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });
      const res = store.stepTrack(ctx.room.code, ctx.participant.id, 1, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized });
    });

    socket.on('player:previous', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(commandSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });
      const res = store.stepTrack(ctx.room.code, ctx.participant.id, -1, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized });
    });

    // ——— Queue Management ———
    socket.on('queue:add', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(queueAddSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.addToQueue(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized, addedItem: res.addedItem });
    });

    socket.on('queue:remove', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(queueRemoveSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.removeFromQueue(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized });
    });

    socket.on('queue:reorder', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(queueReorderSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.reorderQueue(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized });
    });

    socket.on('queue:select', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(queueSelectSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.selectQueueItem(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized });
    });

    // ——— Typing Indicators ———
    socket.on('chat:typing', (_raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      // N-11: typing indicators are rate-limited (10/min per participant,
      // server-level limiter so reconnects do not reset it — N-12).
      if (!checkParticipantLimit(ctx.participant.id, 'typing', 10)) {
        return rateLimited(ack, 'typing indicators');
      }
      socket.to(ctx.room.code).emit('chat:typing', {
        participantId: ctx.participant.id,
        participantName: ctx.participant.name,
      });
      reply(ack, { ok: true });
    });

    // ——— Queue Clear ———
    socket.on('queue:clear', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      const v = validate(commandSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.clearQueue(ctx.room.code, ctx.participant.id, v.data);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      const serialized = store.serializeRoom(res.room);
      if (!res.skipped) {
        io.to(ctx.room.code).emit('queue:updated', {
          queue: serialized.queue,
          currentQueueItemId: serialized.currentQueueItemId,
        });
        io.to(ctx.room.code).emit('playback:state', serialized.playback);
        emitRoomState(res.room);
      }
      reply(ack, { ok: true, state: serialized });
    });

    // ——— Social Features (Chat & Live Reactions) ———
    socket.on('chat:send', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      if (!checkParticipantLimit(ctx.participant.id, 'chat', 30)) {
        return rateLimited(ack, 'chat messages');
      }
      const v = validate(chatSendSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const res = store.addChatMessage(ctx.room.code, ctx.participant.id, v.data.text);
      if (res.error) return reply(ack, { ok: false, code: res.code, error: res.error });

      io.to(ctx.room.code).emit('chat:message', res.message);
      reply(ack, { ok: true, message: res.message });
    });

    socket.on('reaction:send', (raw, ack) => {
      const ctx = requireMembership(ack);
      if (!ctx) return;
      if (!checkParticipantLimit(ctx.participant.id, 'reaction', 30)) {
        return rateLimited(ack, 'reactions');
      }
      const v = validate(reactionSendSchema, raw);
      if (!v.ok) return reply(ack, { ok: false, error: v.error });

      const burst = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        senderId: ctx.participant.id,
        senderName: ctx.participant.name,
        emoji: v.data.emoji,
        sentAtMs: Date.now(),
      };
      io.to(ctx.room.code).emit('reaction:burst', burst);
      reply(ack, { ok: true });
    });

    const handleDisconnect = (roomCode, participantId) => {
      // E-01: on host grace expiry, auto-promote guest and broadcast the
      // updated state (including the role change) so the guest's UI updates.
      const emitGraceExpiredState = (expiredRoom) => {
        const serialized = store.serializeRoom(expiredRoom);
        io.to(expiredRoom.code).emit('room:state', serialized);
        io.to(expiredRoom.code).emit('playback:state', serialized.playback);
        // E-01: notify the new host (promoted guest) about the role change.
        io.to(expiredRoom.code).emit('host:promoted', {
          reason: 'The host disconnected. You are now the host.',
        });
      };
      const room = store.markDisconnected(
        roomCode,
        participantId,
        emitGraceExpiredState,
        // N-15: when a disconnected guest is removed after the grace period,
        // broadcast the updated room state so the host sees the freed slot.
        (removedRoom) => {
          io.to(removedRoom.code).emit('room:state', store.serializeRoom(removedRoom));
        }
      );

      if (room) {
        // I-05: transient socket disconnects (refresh, network switch) reconnect
        // within 1-2s. We delay emitting connection:status { connected: false } by 2s;
        // if room:reconnect or room:join lands within this window, the timer is
        // cancelled and the partner's presence indicator never flashes disconnected.
        const disconnectKey = `${roomCode}:${participantId}`;
        clearDisconnectTimer(roomCode, participantId);
        const timer = setTimeout(() => {
          disconnectPresenceTimers.delete(disconnectKey);
          io.to(roomCode).emit('connection:status', {
            participantId,
            connected: false,
          });
          const curRoom = store.getRoom(roomCode);
          if (curRoom) emitRoomState(curRoom);
        }, 2000);
        timer.unref?.();
        disconnectPresenceTimers.set(disconnectKey, timer);
      }
    };

    // E-01/I-04: send a leave signal when the tab closes. The browser fires
    // `beforeunload`/`pagehide` and Socket.IO may send a close frame.
    // Handling this immediately starts the disconnect grace timer so host
    // vanishing takes exactly the grace period (30s) instead of waiting for
    // socket ping timeouts (~15s) first.
    socket.on('room:tab-close', (_raw, ack) => {
      const { roomCode, participantId } = socket.data;
      if (!roomCode || !participantId) return reply(ack, { ok: true });
      handleDisconnect(roomCode, participantId);
      reply(ack, { ok: true });
      try {
        socket.disconnect(true);
      } catch {
        // ignore
      }
    });

    // ——— Disconnect ———
    socket.on('disconnect', () => {
      const pendingRoom = store.removePendingSocket(socket.id);
      if (pendingRoom) {
        emitRoomState(pendingRoom);
      }

      const { roomCode, participantId } = socket.data;
      if (!roomCode || !participantId) return;

      handleDisconnect(roomCode, participantId);
    });
  });
}
