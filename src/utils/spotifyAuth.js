const AUTH_STORAGE_KEY = 'duet_spotify_auth';
const CLIENT_ID_STORAGE_KEY = 'duet_spotify_client_id';
const PKCE_VERIFIER_KEY = 'duet_spotify_pkce_verifier';
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
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(RETURN_PATH_KEY, window.location.pathname + window.location.search);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    redirect_uri: getSpotifyRedirectUri(),
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
          product: user.product || 'free',
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

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    logoutSpotify();
    return null;
  }

  const updated = {
    ...auth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  saveSpotifyAuth(updated);
  return updated.accessToken;
}

export async function resolveSpotifyUri(track, token) {
  if (track?.spotifyUri && /^spotify:track:[A-Za-z0-9]+$/.test(track.spotifyUri)) {
    return track.spotifyUri;
  }
  const q = `${track?.title || ''} ${track?.artist || ''}`.trim();
  if (!q || !token) return null;

  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.tracks?.items?.[0]?.uri || null;
}
