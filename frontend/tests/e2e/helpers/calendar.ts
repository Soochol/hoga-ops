/**
 * 캡처 화면의 달력에서 **선택 가능한 거래일**을 런타임에 고르는 헬퍼.
 *
 * 스펙들이 `20260518` 처럼 날짜를 박아 두던 시절엔 작성 시점(2026-05)이 지나는 순간
 * 전부 깨졌다 — 달력은 언제나 현재 달을 열기 때문에 셀 자체가 렌더링되지 않는다
 * (`element(s) not found`). 게다가 박아 둔 날짜 중엔 토·일도 있어서, 그 셀을 클릭하는
 * 테스트는 애초에 통과한 적이 없다.
 *
 * **전월을 쓰는 이유**: 이번 달에서 고르면 월초에 과거 거래일이 부족하다(7/30 이면
 * 21일이 있지만 7/3 이면 2일뿐). 전월은 언제나 한 달치가 전부 과거라 18~22일이 나온다.
 * 부수적으로 업스트림 보유 창(~18h) 밖이 보장돼 ADR-0131 의 "보유 창 밖 미확정 갭"
 * 분기도 결정론적으로 걸린다.
 *
 * **날짜는 DOM 이 아니라 API 에서 고른다.** 처음엔 `:not([disabled])` 셀을 읽었는데,
 * 주말은 클라이언트가 즉시 계산하는 반면 휴장일은 `/api/inventory/calendar` 응답이
 * 와야 반영된다 — 그 사이에 읽으면 나중에 비활성이 될 날짜를 집는다(실측: 20260603
 * KRX 휴장일을 골라 놓고 "✕ 마커가 없다" 로 실패). "두 번 읽어 같으면 안정" 같은
 * 대기는 **응답이 아예 안 온 상태도 안정으로 판정**해서 소용이 없었다. UI 가 쓰는
 * 바로 그 API 를 직접 읽으면 경합 자체가 사라진다.
 */
import { expect, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:8765';

/** 클릭 가능한 상태들 — `src/capture/calendarStatus.ts` 의 `disabled: false` 와 동기.
 *  (테스트에서 앱 소스를 import 하지 않는 대신 여기 한 줄로 못박고 근거를 남긴다.) */
const SELECTABLE = new Set(['complete', 'source_partial', 'client_incomplete', 'invalid', 'none']);

interface CalendarCell { date: string; status: string }

export async function selectSymbol(page: Page, query = '삼성', name = /삼성전자/): Promise<void> {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill(query);
  await page.getByText(name, { exact: false }).first().click();
}

/** 달력을 전월로 넘긴다. 종목을 다시 고르면 이번 달로 돌아오므로 그때마다 필요하다. */
export async function previousMonth(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Previous month' }).click();
}

/** 전월의 선택 가능한 날짜를 빠른 순으로 n개. UI 도 전월로 넘겨 둔다.
 *
 *  `skip` 은 **스펙 간 충돌 방지용**이다. 캡처 큐·디스크 픽스처가 백엔드 전역이라
 *  여러 스펙이 같은 날짜를 쓰면 서로를 덮어쓴다(실측: source_partial 이 complete 를
 *  지워 ✓ 자리에 ⚠). 현재 배분:
 *    calendar-markers 0..4 · range-capture 5..7 · cookie-pause 8..12
 */
export async function tradingDates(
  page: Page, n: number, skip = 0, code = '005930',
): Promise<string[]> {
  await previousMonth(page);

  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const res = await fetch(
    `${API}/api/inventory/calendar?code=${code}&year=${prev.getFullYear()}&month=${prev.getMonth() + 1}`);
  expect(res.ok, `calendar API 실패: ${res.status}`).toBe(true);
  const { cells } = await res.json() as { cells: CalendarCell[] };

  // **요청한 달만.** 달력은 6주 그리드라 앞뒤 달의 날짜가 셀에 섞여 들어온다 — 그대로
  // 정렬하면 앞 달 말일이 앞쪽을 차지해 오프셋이 밀리고, 두 끝점 사이에 예상보다 많은
  // 거래일이 들어간다(실측: 3일 범위를 의도했는데 6행이 큐에 들어갔다).
  const prefix = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const dates = cells
    .filter((c) => c.date.startsWith(prefix) && SELECTABLE.has(c.status))
    .map((c) => c.date)
    .sort();
  const picked = dates.slice(skip, skip + n);
  expect(picked, `거래일 ${skip}..${skip + n - 1} 확보 실패 (선택 가능 ${dates.length}일)`)
    .toHaveLength(n);
  return picked;
}
