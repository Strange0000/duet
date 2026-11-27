# Duet — Listen Together

**Two phones. One song. Same second.**

Duet is a private, mobile-first synchronized music listening room built for two people. Create a room, share a 6-character code or `/room/<code>` invite link, and listen together in real time.

## Technology Stack
- **Frontend**: React 18, Vite 6, Tailwind CSS v4, Lucide Icons, HTML5 Canvas, Socket.IO Client
- **Backend**: Node.js, Express 4, Socket.IO 4, Zod, Helmet, `express-rate-limit`, CORS
- **Playback**: Official YouTube IFrame Player API + built-in Web Audio `LocalAudioPlayer` test fixture
- **Testing**: Vitest, Supertest, Socket.IO Client

## Local Setup & Startup

### 1. Install Dependencies
```bash
# from the repo root
npm install
cd server
npm install
```

### 2. Configure Environment (Optional for Local Dev)
```bash
cd server
cp .env.example .env
```
Add `YOUTUBE_API_KEY` in `server/.env` if you want live YouTube Data API v3 search on the backend. Basic rooms, YouTube playback of preloaded tracks, and Audio Only work without any API keys.

### 3. Start Backend & Frontend (Two Terminals)
**Terminal 1 — Backend (`http://localhost:3001`)**
```bash
cd server
npm run dev
```

**Terminal 2 — Frontend (`http://localhost:5173`)**
```bash
# from the repo root
npm run dev
```

### 4. Run Tests & Production Build
```bash
# from the repo root
npm test
npm run build
```

## Creating & Testing a Room
1. Open `http://localhost:5173` in Browser 1 and click **Create a Room**.
2. Copy the 6-character code or `/room/<code>` invite link.
3. Open the invite link in an Incognito window or second device.
4. On the guest browser, tap **Tap to Join Audio** to satisfy mobile autoplay policies.
5. Use **Audio Only** for deterministic local sync testing, or **YouTube** for official YouTube IFrame playback.

## Known Limitations
- **Spotify** is enabled by default (`ENABLE_SPOTIFY=true`). Each listener connects their own Spotify Premium account via OAuth PKCE; see [PROVIDER_LIMITATIONS.md](PROVIDER_LIMITATIONS.md). Set `ENABLE_SPOTIFY=false` to disable it.
- **Free Hosting**: Render free-tier instances sleep after inactivity (cold starts) and in-memory room state resets on restart (there is no Redis adapter yet).
