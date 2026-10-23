import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { BOOK_RECOVERY_COOLDOWN_MS, BOOK_RECOVERY_MAX_ATTEMPTS, confirmBookRecovered, recoverBook, retainBookRecovery } from './bookRecovery';

const scope = { code: '222800', date: '20261023', venue: 'KRX' as const };
it('shares in-flight recovery and a finite cooldown budget across same-code windows', async () => {
  const client = new QueryClient();
  let finish!: () => void;
  const request = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const release = retainBookRecovery(client, scope);
  const releaseSecond = retainBookRecovery(client, scope);
  recoverBook(client, scope, 0);
  recoverBook(client, scope, BOOK_RECOVERY_COOLDOWN_MS);
  expect(request).toHaveBeenCalledTimes(1);
  finish(); await Promise.resolve();
  recoverBook(client, scope, BOOK_RECOVERY_COOLDOWN_MS - 1);
  expect(request).toHaveBeenCalledTimes(1);
  for (let i = 1; i < BOOK_RECOVERY_MAX_ATTEMPTS + 2; i++) {
    recoverBook(client, scope, i * BOOK_RECOVERY_COOLDOWN_MS);
    finish(); await Promise.resolve();
  }
  expect(request).toHaveBeenCalledTimes(BOOK_RECOVERY_MAX_ATTEMPTS);
  expect(request).toHaveBeenLastCalledWith({ queryKey: ['live', 'series', '222800', '20261023', 'KRX'], exact: true }, { cancelRefetch: false });
  release();
  confirmBookRecovered(client, scope);
  recoverBook(client, scope, 10 * BOOK_RECOVERY_COOLDOWN_MS);
  expect(request).toHaveBeenCalledTimes(BOOK_RECOVERY_MAX_ATTEMPTS + 1);
  finish(); await Promise.resolve(); releaseSecond();
  recoverBook(client, scope, 20 * BOOK_RECOVERY_COOLDOWN_MS);
  expect(request).toHaveBeenCalledTimes(BOOK_RECOVERY_MAX_ATTEMPTS + 1);
});

it('isolates subject/date/venue budgets and releases failed requests without unhandled rejection', async () => {
  const client = new QueryClient();
  const request = vi.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('503'));
  const scopes = [scope, { ...scope, venue: 'NXT' as const }, { ...scope, code: '005930' }, { ...scope, date: '20261024' }];
  const releases = scopes.map(s => retainBookRecovery(client, s));
  for (const s of scopes) recoverBook(client, s, 0);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(4);
  recoverBook(client, scope, BOOK_RECOVERY_COOLDOWN_MS);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(5);
  releases.forEach(release => release());
});
