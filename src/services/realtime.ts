import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { config } from '@/config/config';
import { verifyToken } from '@/middleware/auth.middleware';
import { ConnectionRegistry, msUntilExpiry } from '@/services/connections';
import { logger } from '@/utils/logger';

/**
 * Socket.IO events pushed to signed-in terminals. A single store room keeps
 * every register in sync: when a customer pays by QR on one terminal, the
 * dashboard on another updates immediately.
 */
export type RealtimeEvent =
  | 'payment:confirmed'
  | 'payment:expired'
  | 'transaction:completed'
  | 'inventory:low'
  | 'analytics:updated';

const STORE_ROOM = 'store';
let io: Server | null = null;
export const connections = new ConnectionRegistry(5);

export function attachRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: config.client.url, credentials: true },
    // Detect dead clients (closed laptop, dropped Wi-Fi) within ~45s.
    pingInterval: 20_000,
    pingTimeout: 25_000,
    // Clients only listen; nothing large should ever arrive.
    maxHttpBufferSize: 16 * 1024,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.data.user = verifyToken(token);
      socket.data.exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId: string = socket.data.user.sub;
    const evicted = connections.add(userId, socket);
    if (evicted.length)
      logger.debug(`Closed ${evicted.length} old socket(s) for ${socket.data.user.email}`);
    socket.join(STORE_ROOM);

    // A socket must not outlive the session that opened it.
    const ttl = msUntilExpiry(socket.data.exp);
    const expiry = ttl === null ? null : setTimeout(() => socket.disconnect(true), ttl);

    // Bind message / data handler once at connection time (#125)
    const onData = (data: unknown) => {
      logger.debug(`Received socket data from ${socket.data.user.email}: ${JSON.stringify(data)}`);
    };
    socket.on('data', onData);
    socket.on('message', onData);

    // A terminal can disappear without sending a close frame (power loss,
    // dropped Wi-Fi, killed process). Socket.IO normally turns that into a
    // `disconnect`, but the underlying Engine.IO/WebSocket transport can emit
    // `close` or `error` on its own. Clean up on every path; the guard makes
    // the work idempotent so overlapping events cannot double-remove entries.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      socket.off('data', onData);
      socket.off('message', onData);
      socket.off('disconnect', cleanup);
      socket.off('error', cleanup);
      socket.conn.off('close', cleanup);
      socket.conn.off('error', cleanup);
      if (expiry) clearTimeout(expiry);
      connections.remove(userId, socket);
    };
    socket.on('disconnect', cleanup);
    socket.on('error', cleanup);
    socket.conn.on('close', cleanup);
    socket.conn.on('error', cleanup);

    logger.debug(`Terminal connected: ${socket.data.user.email}`);
  });
  return io;
}

/** Broadcasts to every connected terminal. A no-op when sockets are not attached (tests, scripts). */
export function emit(event: RealtimeEvent, payload: unknown): void {
  io?.to(STORE_ROOM).emit(event, payload);
}

export function closeRealtime(): Promise<void> {
  return new Promise((resolve) => {
    if (!io) return resolve();
    io.close(() => resolve());
    io = null;
  });
}
