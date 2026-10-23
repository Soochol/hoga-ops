import type { QueryClient } from '@tanstack/react-query';
import type { LiveVenueOption } from '../state/liveVenue';

export const BOOK_RECOVERY_COOLDOWN_MS = 30_000;
export const BOOK_RECOVERY_MAX_ATTEMPTS = 3;
type Recovery = { references: number; attempts: number; attemptedAt: number; pending: boolean };
const clients = new WeakMap<QueryClient, Map<string, Recovery>>();
export type BookRecoveryScope = { code: string; date: string; venue: LiveVenueOption };
const keyFor = (scope: BookRecoveryScope) => `${scope.date}:${scope.code}:${scope.venue}`;

/** One bounded recovery budget for all active books of the same subject. */
export function retainBookRecovery(client: QueryClient, scope: BookRecoveryScope): () => void {
  let scopes = clients.get(client);
  if (!scopes) { scopes = new Map(); clients.set(client, scopes); }
  const key = keyFor(scope);
  const entry = scopes.get(key) ?? { references: 0, attempts: 0, attemptedAt: -Infinity, pending: false };
  scopes.set(key, entry);
  entry.references++;
  return () => { if (--entry.references === 0 && scopes.get(key) === entry) scopes.delete(key); };
}

export function confirmBookRecovered(client: QueryClient, scope: BookRecoveryScope): void {
  const entry = clients.get(client)?.get(keyFor(scope));
  if (entry) entry.attempts = 0;
}

export function recoverBook(client: QueryClient, scope: BookRecoveryScope, nowMs: number): void {
  const entry = clients.get(client)?.get(keyFor(scope));
  if (!entry || entry.pending || entry.attempts >= BOOK_RECOVERY_MAX_ATTEMPTS
    || nowMs - entry.attemptedAt < BOOK_RECOVERY_COOLDOWN_MS) return;
  entry.pending = true;
  entry.attemptedAt = nowMs;
  entry.attempts++;
  // Join in-flight reads; do not abort/restart them from a second window. Query
  // errors remain on the shared series query and never produce unhandled rejections.
  void client.invalidateQueries({ queryKey: ['live', 'series', scope.code, scope.date, scope.venue], exact: true },
    { cancelRefetch: false }).then(() => { entry.pending = false; }, () => { entry.pending = false; });
}
