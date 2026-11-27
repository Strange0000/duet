const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function fetchProviders(signal) {
  const res = await fetch(`${API_URL}/api/providers`, { signal });
  if (!res.ok) throw new Error('Failed to load provider status');
  return res.json();
}

export async function fetchRoomSummary(roomCode, signal) {
  const res = await fetch(`${API_URL}/api/rooms/${encodeURIComponent(roomCode)}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Room not found');
  }
  return res.json();
}

export async function searchMusicBackend(query, signal) {
  const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Search failed');
  }
  return res.json();
}
