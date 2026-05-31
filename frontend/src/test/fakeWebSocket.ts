export const fakeSockets: FakeWebSocket[] = [];

export class FakeWebSocket {
  url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; fakeSockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  serverClose() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  parsedSent() { return this.sent.map((s) => JSON.parse(s)); }
}

export function installFakeWebSocket(): void {
  fakeSockets.length = 0;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
}
