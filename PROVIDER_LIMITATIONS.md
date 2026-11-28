# Duet — Provider Limitations & Policy Notes

## 1. YouTube (Official IFrame Player API)
- **Allowed**: Playback via the official YouTube IFrame Player API (`https://www.youtube.com/iframe_api`) inside a visible, properly sized player with standard controls and branding preserved.
- **Blocked / Not Implemented**:
  - Downloading or extracting YouTube audio streams.
  - Hiding the video player while continuing audio playback.
  - Blocking, skipping, or tampering with YouTube advertisements.
  - Bypassing embedding restrictions (`Error 101 / 150`).
- **Sync Implications**:
  - Different participants may experience different pre-roll/mid-roll ads or network buffering.
  - When a video disables embedding, Duet displays the error clearly and lets the host pick another track. Audio Only plays synthesized test tones to check room sync.
- **Discovery**:
  - Full YouTube search requires `YOUTUBE_API_KEY` on the backend (`server/.env`). Without it, built-in curated tracks and iTunes metadata search remain available, and users can still test deterministic sync using the built-in **Audio Only** player, which plays test tones for the queued track’s duration.

## 2. Spotify (Enabled — Premium, via OAuth PKCE + Web Playback SDK)
- **Status**: Enabled by default (`ENABLE_SPOTIFY=true`).
- **How it works**: Each listener connects their own Spotify Premium account via OAuth 2.0 Authorization Code with PKCE; playback uses the Spotify Web Playback SDK (Desktop & Android Chrome; note iOS Safari does not support Web Playback SDK DRM/EME in-browser). The Spotify Client ID comes from `VITE_SPOTIFY_CLIENT_ID` or is pasted in the connect dialog (stored locally in the browser).
- **Note**: Spotify's Developer Policy restricts synchronizing Spotify streams with external/third-party streaming services and limits development-mode apps to a small allowlist of registered users. Mixed YouTube + Spotify sync is the app's differentiator; commercial use may need explicit authorization / approval.
- **Server gate**: The backend accepts `spotify` sources only when `ENABLE_SPOTIFY=true` (the default). Setting it to `false` makes the server fall back to YouTube on room create/join and reject Spotify on source change.

## 3. Apple Music / iTunes Search API
- Used for public track metadata and album artwork previews with source attribution.
- Artwork URLs are loaded directly from Apple's CDN and not re-hosted or redistributed.
