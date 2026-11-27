const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function searchMusicBackend(query, signal) {
  const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Search failed');
  }
  return res.json();
}
