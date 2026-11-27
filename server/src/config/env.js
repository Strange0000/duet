import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().default('dev-duet-session-secret-change-in-prod'),
  REDIS_URL: z.string().optional().default(''),
  MONGODB_URI: z.string().optional().default(''),
  YOUTUBE_API_KEY: z.string().optional().default(''),
  ROOM_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),
  MAX_ROOM_PARTICIPANTS: z.coerce.number().int().min(2).max(10).default(2),
  ENABLE_SPOTIFY: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  HOST_GRACE_MS: z.coerce.number().int().min(1000).default(30000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ALLOWED_ORIGINS: parsed.data.CLIENT_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
