import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  YOUTUBE_API_KEY: z.string().optional().default(''),
  ROOM_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),
  MAX_ROOM_PARTICIPANTS: z.coerce.number().int().min(2).max(10).default(6),
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

// E-05/I-06: build the CORS allow-list from CLIENT_ORIGIN, plus auto-detect
// Netlify preview origins (deploy previews, deploy permalinks, branch deploys).
const baseOrigins = parsed.data.CLIENT_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const env = {
  ...parsed.data,
  ALLOWED_ORIGINS: baseOrigins,
  // E-05: returns true for any Netlify preview address shape, including
  // branch deploys like `some-feature--duet-music.netlify.app`.
  isAllowedOrigin(origin) {
    if (!origin) return true; // N-30: same-origin / CLI — accepted on purpose
    if (baseOrigins.includes(origin) || baseOrigins.includes('*')) return true;
    try {
      const url = new URL(origin);
      if (url.origin !== origin) return false;
      if (['localhost', '127.0.0.1'].includes(url.hostname)) {
        return url.protocol === 'http:' || url.protocol === 'https:';
      }
      return url.protocol === 'https:' && !url.port && (
        ['duet-music.netlify.app', 'duet-music.pages.dev', 'duet-music-app.pages.dev'].includes(url.hostname) ||
        /^[a-z0-9-]+--duet-music\.netlify\.app$/.test(url.hostname)
      );
    } catch {
      // Not a URL — reject
    }
    return false;
  },
};
