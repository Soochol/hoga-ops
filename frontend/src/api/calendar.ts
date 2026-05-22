import { apiCall } from './client';
import type { CalendarResponse } from './types';

export function getCalendar(
  code: string,
  year: number,
  month: number,
): Promise<CalendarResponse> {
  return apiCall<CalendarResponse>(
    `/api/inventory/calendar?code=${encodeURIComponent(code)}&year=${year}&month=${month}`,
  );
}
