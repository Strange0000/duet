export const HOME_THEME_KEY = 'duet_home_theme';

export function getHomeTheme() {
  try {
    const saved = localStorage.getItem(HOME_THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Use the system preference when storage is unavailable.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const GLASS_APPEARANCE_KEY = 'duet_room_glass';

export function getGlassAppearance() {
  try {
    return localStorage.getItem(GLASS_APPEARANCE_KEY) === 'on';
  } catch {
    return false;
  }
}

export const ROOM_APPEARANCE_KEY = 'duet_room_appearance';

export function getRoomAppearance() {
  try {
    const saved = localStorage.getItem(ROOM_APPEARANCE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}
