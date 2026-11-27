import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
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

// R2 (follow-up): Netlify deploy previews / branch deploys for this app live
// on <preview>--<production-host> — e.g. deploy-preview-4--duet-music.netlify.app
// or 6b09eabbe0ca7b4da156952b--duet-music.netlify.app. They are the same app
// talking to the same backend, so they must be allowed to call the REST API
// and the socket. The allowance is DERIVED from the origins the operator
// configured (CLIENT_ORIGIN): for each configured *.netlify.app host, only
// its own preview subdomains match — never an arbitrary origin, and never
// another site's previews. The preview prefix must be exactly a Netlify
// deploy-preview number (deploy-preview-<n>) or a deploy permalink hash
// (24 lowercase hex chars); anything else (including a lookalike site such
// as foo--duet-music.netlify.app) is rejected.
const NETLIFY_PREVIEW_PREFIX_PATTERNS = [/^deploy-preview-\d+$/, /^[0-9a-f]{24}$/];

export function isAllowedOrigin(origin) {
  // Requests with no Origin (curl, same-origin, non-browser clients) are
  // not cross-origin at all.
  if (!origin) return true;
  if (env.ALLOWED_ORIGINS.includes(origin) || env.ALLOWED_ORIGINS.includes('*')) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Previews are always served over https.
  if (parsed.protocol !== 'https:') return false;
  for (const allowed of env.ALLOWED_ORIGINS) {
    let allowedUrl;
    try {
      allowedUrl = new URL(allowed);
    } catch {
      continue;
    }
    const host = allowedUrl.hostname;
    if (!host.endsWith('.netlify.app')) continue;
    const suffix = `--${host}`;
    if (!parsed.hostname.endsWith(suffix)) continue;
    const prefix = parsed.hostname.slice(0, -suffix.length);
    if (!prefix) continue;
    if (NETLIFY_PREVIEW_PREFIX_PATTERNS.some((re) => re.test(prefix))) return true;
  }
  return false;
}
