import React, { useState } from 'react';
import { Check, Copy, ExternalLink, LogOut, X } from 'lucide-react';
import {
  canUseSpotify,
  getSpotifyClientId,
  getSpotifyRedirectUri,
  getStoredSpotifyAuth,
  logoutSpotify,
  startSpotifyLogin,
} from '../utils/spotifyAuth';

export default function SpotifyConnectModal({ open, onClose, onConnected, onDisconnected }) {
  const [clientId, setClientId] = useState(() => getSpotifyClientId());
  const [error, setError] = useState('');
  const [copiedUri, setCopiedUri] = useState(false);
  const [auth, setAuth] = useState(() => getStoredSpotifyAuth());

  if (!open) return null;

  const redirectUri = getSpotifyRedirectUri();
  const hasEnvClientId = Boolean(import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim());

  const handleCopyRedirect = () => {
    navigator.clipboard?.writeText(redirectUri).catch(() => {});
    setCopiedUri(true);
    setTimeout(() => setCopiedUri(false), 1800);
  };

  const handleConnect = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await startSpotifyLogin(clientId);
    } catch (err) {
      setError(err.message || 'Could not start Spotify login');
    }
  };

  const handleDisconnect = () => {
    logoutSpotify();
    setAuth(null);
    onDisconnected?.();
  };

  return (
    <div className="spotify-connect-overlay fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="spotify-connect-panel w-full max-w-md rounded-3xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-500 text-zinc-950 shadow-lg">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
              </svg>
            </span>
            <div>
              <h3 className="font-display text-lg font-bold text-white">Spotify Premium</h3>
              <p className="text-xs text-zinc-400">Sync full tracks using your Spotify account</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white cursor-pointer"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {auth?.accessToken ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <p className="text-xs font-semibold text-emerald-300 uppercase tracking-wider">Connected</p>
              <p className="mt-1 text-base font-bold text-white">
                {auth.user?.displayName || 'Spotify Account'}
              </p>
              <p className="mt-0.5 text-xs text-zinc-300">
                Plan:{' '}
                <span className="font-semibold capitalize">
                  {auth.user?.product || 'unknown'}
                </span>
                {!canUseSpotify(auth) && (
                  <span className="block text-amber-300">
                    Spotify Premium is required for Audio Only. YouTube is available with a Free account.
                  </span>
                )}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleDisconnect}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/5 py-2.5 text-xs font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5" /> Disconnect
              </button>
              <button
                disabled={!canUseSpotify(auth)}
                onClick={() => {
                  onConnected?.();
                  onClose();
                }}
                className="flex-1 rounded-full bg-emerald-500 py-2.5 text-xs font-bold text-zinc-950 hover:bg-emerald-400 enabled:cursor-pointer disabled:opacity-50"
              >
                Use Spotify
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleConnect} className="mt-5 space-y-4">
            <p className="text-xs leading-relaxed text-zinc-400">
              Requires a <strong className="text-white">Spotify Premium</strong> account. Works on Desktop &amp; Android Chrome. Audio Only plays full tracks from Spotify’s catalog.
            </p>

            {!hasEnvClientId && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-amber-200/90">
                <strong className="text-amber-100">Spotify needs your own developer app.</strong>{' '}
                Duet has no built-in Spotify app yet, so full-song Spotify playback here
                requires a Spotify developer app. If you have one, paste its Client ID below.
              </div>
            )}

            {!hasEnvClientId && (
              <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold tracking-wider text-zinc-300 uppercase">
                    Spotify App Client ID
                  </label>
                  <a
                    href="https://developer.spotify.com/dashboard"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 hover:text-emerald-300"
                  >
                    Dashboard <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setError('');
                  }}
                  placeholder="Paste your Spotify Client ID..."
                  className="w-full rounded-xl border border-white/10 bg-zinc-950 px-3 py-2 font-mono spotify-client-id text-xs text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
                />
                <div className="pt-1 text-[11px] text-zinc-500">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-300">Redirect URI</span>
                    <button
                      type="button"
                      onClick={handleCopyRedirect}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
                    >
                      {copiedUri ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      {copiedUri ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <code className="mt-1 block break-all font-mono text-[11px] leading-relaxed text-zinc-300">{redirectUri}</code>
                  <p className="mt-1">Add this exact URI to your Spotify app&apos;s Redirect URIs in the dashboard.</p>
                </div>
              </div>
            )}

            {error && <p className="text-xs font-medium text-rose-400">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-full border border-white/10 bg-white/5 py-2.5 text-xs font-semibold text-zinc-300 hover:bg-white/10 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 rounded-full bg-emerald-500 py-2.5 text-xs font-bold text-zinc-950 hover:bg-emerald-400 cursor-pointer"
              >
                Connect Spotify
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
