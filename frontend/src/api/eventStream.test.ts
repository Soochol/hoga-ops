import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';
import * as client from './client';
import { subscribeToCaptureEvents, useEventStream } from './eventStream';
import type { PushEvent } from './types';

beforeEach(() => {
  installFakeWebSocket();
  resetWs();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
});

async function connect() {
  await new Promise((r) => setTimeout(r, 0));
  const sock = fakeSockets[0];
  sock.open();
  return sock;
}

describe('subscribeToCaptureEvents', () => {
  it('delivers capture_queued events', async () => {
    const events: PushEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_queued', items: [] } });
    expect(events.map((e) => e.type)).toEqual(['capture_queued']);
  });

  it('delivers capture_dismissed (regression: dropped at two levels before)', async () => {
    const events: PushEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_dismissed', item_ids: ['x'] } });
    expect(events.map((e) => e.type)).toEqual(['capture_dismissed']);
  });

  it('drops non-capture events (inventory_added)', async () => {
    const events: PushEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'inventory_added', code: '005930', date: '20260520' } });
    expect(events).toHaveLength(0);
  });
});

describe('useEventStream disconnect handler', () => {
  it('invalidates queue + calendar + stock dates on disconnect', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useEventStream(), { wrapper });
    const sock = await connect();
    sock.serverClose();
    await new Promise((r) => setTimeout(r, 0));
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: any) => Array.isArray(c?.queryKey) && c.queryKey[0] === 'stock-dates')).toBe(true);
    expect(calls.some((c: any) => Array.isArray(c?.queryKey) && c.queryKey.join(',') === 'capture,queue')).toBe(true);
    expect(calls.some((c: any) => typeof c?.predicate === 'function')).toBe(true);
  });
});
