import { createServer } from 'node:http';
import { attachRealtime, closeRealtime, connections } from '@/services/realtime';

jest.mock('socket.io', () => {
  const handlers: Record<string, (socket: unknown) => void> = {};
  class FakeServer {
    use = jest.fn();
    on(event: string, fn: (socket: unknown) => void) {
      handlers[event] = fn;
      return this;
    }
    to = jest.fn(() => ({ emit: jest.fn() }));
    close(callback: () => void) {
      callback();
    }
  }
  return { Server: FakeServer, __handlers: handlers };
});

const mockHandlers = (jest.requireMock('socket.io') as { __handlers: Record<string, (s: unknown) => void> })
  .__handlers;

type Listener = () => void;

function emitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, fn: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    off(event: string, fn: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== fn));
    },
    emit(event: string) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn();
    },
    count(event: string) {
      return listeners.get(event)?.length ?? 0;
    },
  };
}

function fakeSocket(id: string, expiresInSeconds = 60) {
  const conn = emitter();
  const socket = {
    ...emitter(),
    id,
    conn,
    data: {
      user: { sub: 'u1', email: 'terminal@example.com', role: 'cashier' },
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    },
    join: jest.fn(),
    disconnect: jest.fn(),
  };
  return socket;
}

describe('realtime socket cleanup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    closeRealtime();
    jest.useRealTimers();
  });

  it('releases the registry entry when the transport closes without a disconnect frame', () => {
    attachRealtime(createServer());
    const socket = fakeSocket('s1');

    mockHandlers.connection(socket);
    expect(connections.count()).toBe(1);

    socket.conn.emit('close');
    expect(connections.count()).toBe(0);
    expect(socket.conn.count('close')).toBe(0);
  });

  it('cleans up on transport error and is idempotent across overlapping events', () => {
    attachRealtime(createServer());
    const socket = fakeSocket('s2');

    mockHandlers.connection(socket);
    socket.conn.emit('error');
    socket.emit('disconnect');
    socket.conn.emit('close');

    expect(connections.count()).toBe(0);
    expect(socket.conn.count('close')).toBe(0);
    expect(socket.count('disconnect')).toBe(0);
  });
});
