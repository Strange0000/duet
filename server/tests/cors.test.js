// R2 (follow-up): deploy-preview origins must be able to call the backend.
// The preview frontend (e.g. https://6b09eabbe0ca7b4da156952b--duet-music.netlify.app)
// calls the production backend for /api/youtube/resolve, but the backend's
// CORS allowlist (CLIENT_ORIGIN) only listed the production origin, so the
// browser blocked the resolve fetch and every guest/host add failed with
// "No playable YouTube version found" — even though /resolve itself works.
// The fix: isAllowedOrigin() also allows this app's own Netlify preview
// subdomains, derived from the configured origins — never any origin.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const PRODUCTION_ORIGIN = 'https://duet-music.netlify.app';
const PREVIEW_HASH = 'https://6b09eabbe0ca7b4da156952b--duet-music.netlify.app';
const PREVIEW_PR = 'https://deploy-preview-4--duet-music.netlify.app';

describe('isAllowedOrigin (R2 preview CORS)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadIsAllowedOrigin(clientOrigin) {
    process.env.CLIENT_ORIGIN = clientOrigin;
    const mod = await import('../src/config/env.js');
    return mod.isAllowedOrigin;
  }

  it('allows the configured production origin', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin(PRODUCTION_ORIGIN)).toBe(true);
  });

  it('allows a deploy-permalink preview origin (24-hex hash)', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin(PREVIEW_HASH)).toBe(true);
  });

  it('allows a PR deploy-preview origin (deploy-preview-<n>)', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin(PREVIEW_PR)).toBe(true);
  });

  it('allows requests with no Origin (curl, same-origin, non-browser)', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('rejects a random other origin', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
    expect(isAllowedOrigin('https://duet-music.netlify.app.evil.com')).toBe(false);
    expect(isAllowedOrigin('https://other-site.netlify.app')).toBe(false);
  });

  it('rejects a lookalike Netlify site (foo--duet-music is not a preview of duet-music)', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin('https://foo--duet-music.netlify.app')).toBe(false);
    expect(isAllowedOrigin('https://deploy-preview-4--foo--duet-music.netlify.app')).toBe(false);
  });

  it('rejects non-https preview origins', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(PRODUCTION_ORIGIN);
    expect(isAllowedOrigin('http://6b09eabbe0ca7b4da156952b--duet-music.netlify.app')).toBe(false);
  });

  it('rejects previews when the configured origin is not a Netlify site', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin('http://localhost:5173');
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin(PREVIEW_HASH)).toBe(false);
  });

  it('derives preview allowance from every configured Netlify origin', async () => {
    const isAllowedOrigin = await loadIsAllowedOrigin(
      `${PRODUCTION_ORIGIN},https://duet-staging.netlify.app`
    );
    expect(isAllowedOrigin('https://deploy-preview-9--duet-staging.netlify.app')).toBe(true);
    expect(isAllowedOrigin(PREVIEW_HASH)).toBe(true);
    expect(isAllowedOrigin('https://deploy-preview-9--other.netlify.app')).toBe(false);
  });
});

describe('Express CORS with preview origins (R2 follow-up)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadApp(clientOrigin) {
    process.env.CLIENT_ORIGIN = clientOrigin;
    const { createApp } = await import('../src/index.js');
    return createApp();
  }

  it('answers a preview-origin request with the allow-origin header', async () => {
    const created = await loadApp(PRODUCTION_ORIGIN);
    try {
      const res = await request(created.app)
        .get('/health')
        .set('Origin', PREVIEW_HASH);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(PREVIEW_HASH);
    } finally {
      clearInterval(created.cleanupInterval);
    }
  });

  it('answers a preview-origin preflight (OPTIONS)', async () => {
    const created = await loadApp(PRODUCTION_ORIGIN);
    try {
      const res = await request(created.app)
        .options('/api/youtube/resolve')
        .set('Origin', PREVIEW_PR)
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(PREVIEW_PR);
    } finally {
      clearInterval(created.cleanupInterval);
    }
  });

  it('rejects a random origin', async () => {
    const created = await loadApp(PRODUCTION_ORIGIN);
    try {
      const res = await request(created.app)
        .get('/health')
        .set('Origin', 'https://evil.com');
      expect(res.status).toBe(500);
    } finally {
      clearInterval(created.cleanupInterval);
    }
  });
});
