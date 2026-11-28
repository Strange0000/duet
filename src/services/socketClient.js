import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

let socketInstance = null;

export function getSocket() {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnection: true,
      reconnectionAttempts: 12,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.4,
      timeout: 8000,
    });
  }
  return socketInstance;
}

export function emitAck(event, payload = {}, timeoutMs = 60000) {
  const socket = getSocket();
  if (!socket.connected) {
    socket.connect();
  }

  return socket.timeout(timeoutMs).emitWithAck(event, payload).catch(() => {
    throw new Error(`Request timed out (${event})`);
  });
}

export function generateCommandId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
