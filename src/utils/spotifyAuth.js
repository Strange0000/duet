const AUTH_STORAGE_KEY = 'duet_spotify_auth';
const CLIENT_ID_STORAGE_KEY = 'duet_spotify_client_id';
const PKCE_VERIFIER_KEY = 'duet_spotify_pkce_verifier';
const OAUTH_STATE_KEY = 'duet_spotify_oauth_state';
const RETURN_PATH_KEY = 'duet_spotify_return_path';

const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');

export function getSpotifyRedirectUri() {
  if (typeof window === 'undefined') return 'http://localhost:5173/spotify-callback';
  return `${window.location.origin}/spotify-callback`;
}

export function getSpotifyClientId() {
  const envId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
  if (envId && envId.trim()) return envId.trim();
  try {
    return localStorage.getItem(CLIENT_ID_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setSpotifyClientId(clientId) {
  try {
    if (clientId && clientId.trim()) {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId.trim());
    } else {
      localStorage.removeItem(CLIENT_ID_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getStoredSpotifyAuth() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function canUseSpotify(auth = getStoredSpotifyAuth()) {
  return Boolean(auth?.accessToken) && (!auth.user?.product || auth.user.product === 'premium');
}

function saveSpotifyAuth(auth) {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  } catch {
    // Ignore storage errors
  }
}

export function logoutSpotify() {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

function generateRandomString(length = 64) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => possible[v % possible.length]).join('');
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function startSpotifyLogin(customClientId) {
  const clientId = (customClientId || getSpotifyClientId()).trim();
  if (!clientId) {
    throw new Error('Spotify Client ID is required.');
  }
  setSpotifyClientId(clientId);

  const verifier = generateRandomString(64);
  const challenge = await generateCodeChallenge(verifier);
  // N-20: OAuth `state` (CSRF protection) — random value stored locally and
  // validated in handleSpotifyCallback.
  const state = generateRandomString(32);
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OAUTH_STATE_KEY, state);
  sessionStorage.setItem(RETURN_PATH_KEY, window.location.pathname + window.location.search);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    redirect_uri: getSpotifyRedirectUri(),
    state,
  });

  window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`);
}

export async function fetchSpotifyProfile(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function handleSpotifyCallback(search) {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error) {
    throw new Error(`Spotify authorization failed: ${error}`);
  }
  const code = params.get('code');
  // N-20: reject the callback if the returned state does not match the one
  // stored when login started.
  const returnedState = params.get('state');
  const storedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
  if (!returnedState || !storedState || returnedState !== storedState) {
    throw new Error('Spotify login was rejected: state mismatch. Please try connecting again.');
  }
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  const clientId = getSpotifyClientId();
  if (!code || !verifier || !clientId) {
    throw new Error('Missing Spotify authorization state. Please try connecting again.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: getSpotifyRedirectUri(),
    code_verifier: verifier,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to exchange Spotify token');
  }

  const user = await fetchSpotifyProfile(data.access_token).catch(() => null);
  const auth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    user: user
      ? {
          id: user.id,
          displayName: user.display_name || user.id,
          product: user.product || null,
        }
      : null,
  };
  saveSpotifyAuth(auth);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);

  const returnPath = sessionStorage.getItem(RETURN_PATH_KEY) || '/';
  sessionStorage.removeItem(RETURN_PATH_KEY);
  return { auth, returnPath };
}

export async function getValidSpotifyToken() {
  const auth = getStoredSpotifyAuth();
  if (!auth?.accessToken) return null;
  if (Date.now() < (auth.expiresAt || 0) - 60_000) {
    return auth.accessToken;
  }

  const clientId = getSpotifyClientId();
  if (!auth.refreshToken || !clientId) {
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
  });

  // N-21: retry the refresh once; only log out on a real auth failure
  // (400/401 with invalid_grant / invalid_client). A transient failure
  // (network error, 5xx) returns null WITHOUT logging the user out.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      if (attempt === 0) continue; // transient network error — retry once
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      const updated = {
        ...auth,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || auth.refreshToken,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      };
      saveSpotifyAuth(updated);
      return updated.accessToken;
    }
    const isAuthFailure =
      (res.status === 400 || res.status === 401) &&
      (data.error === 'invalid_grant' || data.error === 'invalid_client');
    if (isAuthFailure) {
      logoutSpotify();
      return null;
    }
    if (attempt === 0 && (res.status >= 500 || res.status === 429)) continue; // transient — retry once
    return null;
  }
  return null;
}

function normalizeRecordingName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/\s*[[(](?:(?:official\s+)?(?:music\s+)?video|official audio|lyrics?|visualizer)[\])]/gi, '')
    .replace(/\bvevo$|\s*-\s*topic$/gi, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

export async function resolveSpotifyUri(track, token) {
  const spotifyTrackUri = /^spotify:track:[A-Za-z0-9]+$/;
  if (spotifyTrackUri.test(track?.spotifyUri || '')) return track.spotifyUri;

  const title = normalizeRecordingName(track?.title);
  const artist = normalizeRecordingName(track?.artist);
  if (!title || !artist || !token) return null;

  const q = `${track.title} ${track.artist}`.trim();
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const match = data?.tracks?.items?.find((item) => {
    const name = normalizeRecordingName(item.name);
    const artistMatches = item.artists?.some(({ name }) => normalizeRecordingName(name) === artist);
    return artistMatches && (title === name || title === `${artist} ${name}`)
      && item.is_playable !== false
      && spotifyTrackUri.test(item.uri || '');
  });
  return match?.uri || null;
}
