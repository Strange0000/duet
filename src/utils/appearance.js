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
