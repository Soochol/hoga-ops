import { apiUrl } from './client';
import type { CalendarResponse } from './types';

export async function getCalendar(
  code: string,
  year: number,
  month: number,
): Promise<CalendarResponse> {
  const base = await apiUrl('/api/inventory/calendar');
  const url = `${base}?code=${encodeURIComponent(code)}&year=${year}&month=${month}`;
  const r = await fetch(url);
  if (!r.ok)
    throw new Error(
      `GET /api/inventory/calendar code=${code} ${year}-${month} failed: ${r.status}`,
    );
  return r.json();
}
