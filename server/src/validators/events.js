import { z } from 'zod';

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{6}$/, 'Room code must be 6 valid characters');

export const sourceSchema = z.enum(['youtube', 'local', 'spotify']);

export const trackSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().min(1).max(200),
  album: z.string().trim().max(200).optional().default('Single'),
  durationSec: z.number().finite().min(1).max(43200),
  coverImage: z.string().max(500).nullable().optional(),
  coverGradient: z.string().max(120).optional(),
  accentColor: z.string().max(32).optional(),
  secondaryColor: z.string().max(32).optional(),
  youtubeId: z.string().max(64).nullable().optional(),
  localFixtureId: z.string().max(64).nullable().optional(),
  sourceAttribution: z.string().max(120).optional(),
  attributionUrl: z.string().max(500).optional(),
  dedication: z.string().trim().max(180).optional(),
});

export const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(40).optional().default('Host'),
  source: sourceSchema.optional().default('youtube'),
  initialTracks: z.array(trackSchema).max(50).optional(),
});

export const joinRoomSchema = z.object({
  roomCode: roomCodeSchema,
  name: z.string().trim().min(1).max(40).optional().default('Guest'),
  source: sourceSchema.optional().default('youtube'),
});

export const reconnectRoomSchema = z.object({
  roomCode: roomCodeSchema,
  sessionToken: z.string().min(16).max(128),
});

export const commandBaseSchema = z.object({
  commandId: z.string().min(1).max(80).optional(),
  expectedRoomVersion: z.number().int().nonnegative().optional(),
});

export const playerStatusSchema = z.object({
  ready: z.boolean().optional(),
  buffering: z.boolean().optional(),
  reportedPositionMs: z.number().finite().min(0).max(43200000).optional(),
  driftMs: z.number().finite().min(-600000).max(600000).optional(),
  endedTrackVersion: z.number().int().nonnegative().optional(),
});

export const playerPlaySchema = commandBaseSchema.extend({
  positionMs: z.number().finite().min(0).max(43200000).optional(),
  scheduleLeadMs: z.number().int().min(0).max(3000).optional(),
});

export const playerPauseSchema = commandBaseSchema.extend({
  positionMs: z.number().finite().min(0).max(43200000).optional(),
});

export const playerSeekSchema = commandBaseSchema.extend({
  positionMs: z.number().finite().min(0).max(43200000),
});

export const queueAddSchema = commandBaseSchema.extend({
  track: trackSchema,
  playNow: z.boolean().optional().default(false),
});

export const queueRemoveSchema = commandBaseSchema.extend({
  queueItemId: z.string().min(1).max(80),
});

export const queueReorderSchema = commandBaseSchema.extend({
  fromIndex: z.number().int().min(0).max(200),
  toIndex: z.number().int().min(0).max(200),
});

export const queueSelectSchema = commandBaseSchema.extend({
  queueItemId: z.string().min(1).max(80),
});

export const participantUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  source: sourceSchema.optional(),
});

export const roomSettingsSchema = commandBaseSchema.extend({
  allowGuestQueue: z.boolean().optional(),
  theme: z.enum(['midnight', 'aurora', 'sunset', 'rose', 'ocean', 'minimal']).optional(),
});

export const transferHostSchema = commandBaseSchema.extend({
  targetParticipantId: z.string().min(1).max(80),
});

export const syncPingSchema = z.object({
  clientSentAtMs: z.number().finite().nonnegative(),
  seq: z.number().int().nonnegative().optional(),
});

export const chatSendSchema = z.object({
  text: z.string().trim().min(1).max(500),
  clientMsgId: z.string().max(80).optional(),
});

export const reactionSendSchema = z.object({
  emoji: z.enum(['❤️', '🔥', '🎵', '😊', '✨', '😭']),
});
