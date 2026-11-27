# Duet — Listen Together

**Two phones. One song. Same second.**

Duet is a private, mobile-first synchronized music listening room built for two people. Create a room, share a 6-character code or `/room/<code>` invite link, and listen together in real time.

## Technology Stack
- **Frontend**: React 18, Vite 6, Tailwind CSS v4, Lucide Icons, HTML5 Canvas, Socket.IO Client
- **Backend**: Node.js, Express 4, Socket.IO 4, Zod, Helmet, `express-rate-limit`, CORS
- **Playback**: Official YouTube IFrame Player API + built-in Web Audio `LocalAudioPlayer` test fixture
- **Testing**: Vitest, Supertest, Socket.IO Client

## Local Setup & Startup (Windows PowerShell)

### 1. Install Dependencies
```powershell
cd C:\Users\Strange\.gemini\antigravity\scratch\duet
npm install
cd server
npm install
```

### 2. Configure Environment (Optional for Local Dev)
```powershell
cd C:\Users\Strange\.gemini\antigravity\scratch\duet\server
Copy-Item .env.example .env
```
Add `YOUTUBE_API_KEY` in `server/.env` if you want live YouTube Data API v3 search on the backend. Basic rooms, YouTube playback of preloaded tracks, and Local Test Audio work without any API keys.

### 3. Start Backend & Frontend (Two Terminals)
**Terminal 1 — Backend (`http://localhost:3001`)**
```powershell
cd C:\Users\Strange\.gemini\antigravity\scratch\duet\server
npm run dev
```

**Terminal 2 — Frontend (`http://localhost:5173`)**
```powershell
cd C:\Users\Strange\.gemini\antigravity\scratch\duet
npm run dev
```

### 4. Run Tests & Production Build
```powershell
cd C:\Users\Strange\.gemini\antigravity\scratch\duet
npm test
npm run build
```

## Creating & Testing a Room
1. Open `http://localhost:5173` in Browser 1 and click **Create a Room**.
2. Copy the 6-character code or `/room/<code>` invite link.
3. Open the invite link in an Incognito window or second device.
4. On the guest browser, tap **Tap to Join Audio** to satisfy mobile autoplay policies.
5. Use **Test Audio** for deterministic local sync testing, or **YouTube** for official YouTube IFrame playback.

## Known Limitations
- **Spotify** is disabled (`ENABLE_SPOTIFY=false`) pending Spotify developer policy authorization (see [PROVIDER_LIMITATIONS.md](PROVIDER_LIMITATIONS.md)).
- **Free Hosting**: Render free-tier instances sleep after inactivity (cold starts) and in-memory room state resets on restart unless `REDIS_URL` is configured.
