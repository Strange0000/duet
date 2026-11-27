# Duet — Manual Test Checklist

> Run these tests on real devices after each major change. Mark each item with ✅ or ❌.

## 1. Room Creation & Joining

| # | Test | Chrome Desktop | Firefox Desktop | Safari iOS | Chrome Android |
|---|------|:-:|:-:|:-:|:-:|
| 1.1 | Click "Create a Room" → room code displayed | | | | |
| 1.2 | Copy room code → clipboard contains 6-char code | | | | |
| 1.3 | Copy invite link → clipboard contains `/room/<CODE>` URL | | | | |
| 1.4 | Join via room code input → guest enters room | | | | |
| 1.5 | Join via invite link (paste URL in new tab) | | | | |
| 1.6 | Invalid/expired room code → clear error message | | | | |
| 1.7 | Room full (3rd participant) → "Room is full" error | | | | |

## 2. Source Selection

| # | Test | Chrome Desktop | Chrome Android |
|---|------|:-:|:-:|
| 2.1 | Select YouTube source → YouTube IFrame loads | | |
| 2.2 | Select Local Test Audio → visualizer canvas appears | | |
| 2.3 | Spotify shows "Coming Soon" (disabled) | | |
| 2.4 | Switch source mid-session → player adapter reinitializes | | |

## 3. Playback Controls (Host Only)

| # | Test | Chrome Desktop | Safari iOS |
|---|------|:-:|:-:|
| 3.1 | Play → both devices start playback | | |
| 3.2 | Pause → both devices pause at same position | | |
| 3.3 | Seek via scrubber → both devices jump to position | | |
| 3.4 | Skip forward → next track loads on both | | |
| 3.5 | Skip back → previous track loads on both | | |
| 3.6 | Guest controls are locked (disabled buttons visible) | | |

## 4. Synchronization

| # | Test | Expected |
|---|------|----------|
| 4.1 | Open sync metrics drawer → RTT, offset, drift shown | |
| 4.2 | Drift stays <350ms during normal playback | |
| 4.3 | Click "Recalibrate Clock" → new RTT/offset values | |
| 4.4 | Tab away and return → resync on visibility change | |
| 4.5 | Corrections counter increments only on large drift | |

## 5. Queue Management

| # | Test | Expected |
|---|------|----------|
| 5.1 | Search songs → results appear (YouTube + iTunes) | |
| 5.2 | Paste YouTube URL → video resolves and adds to queue | |
| 5.3 | Add song → appears in queue panel | |
| 5.4 | Click queue item → starts playing that track | |
| 5.5 | Reorder (up/down arrows) → order changes | |
| 5.6 | Remove track → removed from queue | |
| 5.7 | "Clear All" button → empties entire queue | |
| 5.8 | Guest add blocked when "Allow guest to add" unchecked | |
| 5.9 | Guest can add when "Allow guest to add" checked | |
| 5.10 | Dedication field → shows heart icon on track | |

## 6. Chat & Social

| # | Test | Expected |
|---|------|:-:|
| 6.1 | Send chat message → appears on both sides | |
| 6.2 | Typing indicator → "· · · typing" appears for partner | |
| 6.3 | Unread count badge on Chat tab when messages arrive | |
| 6.4 | Opening Chat tab clears unread count | |
| 6.5 | Send emoji reaction → floating bubble on both devices | |
| 6.6 | Messages capped at 100 (oldest trimmed) | |

## 7. Room Settings

| # | Test | Expected |
|---|------|:-:|
| 7.1 | Change theme → both devices update colors | |
| 7.2 | Transfer host → roles swap, controls update | |
| 7.3 | "End Room" → both devices return to landing | |
| 7.4 | Privacy button → modal shows privacy info | |

## 8. Session Summary

| # | Test | Expected |
|---|------|:-:|
| 8.1 | Click back arrow → session summary modal appears | |
| 8.2 | Modal shows duration, tracks played, queue size | |
| 8.3 | "Stay" button → returns to room | |
| 8.4 | "Leave Room" button → exits to landing page | |

## 9. Mobile & Autoplay

| # | Test | Safari iOS | Chrome Android |
|---|------|:-:|:-:|
| 9.1 | Guest sees "Tap to unlock synced audio" banner | | |
| 9.2 | Tapping unlock button starts audio playback | | |
| 9.3 | Mobile layout is responsive (no horizontal scroll) | | |
| 9.4 | Player controls usable with one hand | | |

## 10. Reconnection

| # | Test | Expected |
|---|------|:-:|
| 10.1 | Disconnect WiFi briefly → reconnects and resumes | |
| 10.2 | Partner status shows "Disconnected" during drop | |
| 10.3 | Refresh page → auto-reconnects via sessionStorage | |
| 10.4 | Host disconnect >30s → playback auto-pauses | |

## 11. PWA

| # | Test | Chrome Desktop | Chrome Android |
|---|------|:-:|:-:|
| 11.1 | Install banner appears on first visit | | |
| 11.2 | "Install" button triggers browser install prompt | | |
| 11.3 | "Not now" dismisses banner | | |
| 11.4 | Offline → service worker shows offline notice | | |

## 12. Edge Cases

| # | Test | Expected |
|---|------|:-:|
| 12.1 | Embed-blocked YouTube video → error + "Find Embeddable" | |
| 12.2 | Empty queue → no crash, graceful empty state | |
| 12.3 | Very long song title → truncated with ellipsis | |
| 12.4 | Demo mode → all features work locally (no server) | |
| 12.5 | `prefers-reduced-motion` → visualizer shows static gradient | |

---

**Tester:** _______________  
**Date:** _______________  
**Build:** _______________  
