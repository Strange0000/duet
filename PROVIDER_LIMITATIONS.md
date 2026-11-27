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
  - When a video disables embedding, Duet displays the error clearly and lets the host pick another track or switch to Local Test Audio.
- **Discovery**:
  - Full YouTube search requires `YOUTUBE_API_KEY` on the backend (`server/.env`). Without it, built-in curated tracks and iTunes metadata search remain available, and users can still test deterministic sync using the built-in **Test Audio** player.

## 2. Spotify (Currently Unavailable / Coming Soon)
- **Status**: Disabled by default (`ENABLE_SPOTIFY=false`).
- **Reason**: Spotify's Developer Policy restricts synchronizing Spotify streams with external/third-party streaming services and limits development-mode apps to a small allowlist of registered users.
- **Future Requirements**:
  - Explicit authorization / commercial approval if cross-platform sync is pursued.
  - OAuth 2.0 Authorization Code with PKCE, Premium account verification, and Spotify Web Playback SDK (Desktop & Android Chrome; note iOS Safari does not support Web Playback SDK DRM/EME in-browser).

## 3. Apple Music / iTunes Search API
- Used for public track metadata and album artwork previews with source attribution.
- Artwork URLs are loaded directly from Apple's CDN and not re-hosted or redistributed.
