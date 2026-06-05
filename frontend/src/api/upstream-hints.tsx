/** Per-surface user-facing copy keyed by UpstreamCode (ADR-0009).
 *
 *  Adding a new UpstreamCode value to types.ts triggers TypeScript errors
 *  in every map below that lacks the new key — that's the structural payoff.
 */
import type { ReactNode } from 'react';
import type { UpstreamCode } from './types';

/** Empty-state hint shown in SymbolSearch when the Symbol Master is empty. */
export const symbolSearchHints: Record<UpstreamCode, ReactNode> = {
  kis_holiday_fetch_failed: (
    <>KIS 거래일 조회 일시 오류 — 종목 검색과는 무관합니다. 자격증명 문제가 아니니 잠시 후 재시도하세요.</>
  ),
  kis_credentials_missing: (
    <>KIS 자격증명 미설정 — 종목 검색과는 무관합니다. <code>.env</code>에 <code>KIS_APP_KEY</code>/<code>KIS_APP_SECRET</code>을 설정하고 재시도하세요.</>
  ),
  cookie_expired: (
    <>hogaplay 쿠키가 만료되어 종목 목록을 가져올 수 없습니다 — 쿠키를 갱신하세요.</>
  ),
  cookie_missing: (
    <>
      hogaplay 쿠키가 없습니다 — <code>.env</code> 또는 <code>.cookie</code>{' '}
      파일에 설정하세요.
    </>
  ),
  hogaplay_http_error: (
    <>hogaplay에서 오류가 반환되었습니다 — 잠시 후 Refresh를 시도하세요.</>
  ),
  symbol_master_not_initialized: (
    <>
      종목 목록이 아직 다운로드되지 않았습니다 —{' '}
      <strong>설정 → Symbol Master → Update Now</strong>를 누르거나, 6자리 코드를 직접 입력해 진행할 수 있습니다.
    </>
  ),
  disk_write_failed: (
    <>디스크 쓰기에 실패했습니다 — 저장 공간 또는 권한을 확인하세요.</>
  ),
  kis_master_fetch_failed: (
    <>
      KIS 종목 마스터(.mst) 다운로드에 실패했습니다 — 네트워크를 확인하고 잠시 후{' '}
      <strong>Refresh</strong>를 시도하세요.
    </>
  ),
};

/** Banner above the calendar grid (informational; data still renders). */
export const calendarHints: Record<UpstreamCode, ReactNode> = {
  kis_holiday_fetch_failed: (
    <>KIS 거래일 조회 일시 오류 — 휴일 표시가 정확하지 않을 수 있습니다. 자격증명 문제가 아니니 잠시 후 새로고침하세요.</>
  ),
  kis_credentials_missing: (
    <>KIS 자격증명 미설정으로 휴일 표시가 정확하지 않을 수 있습니다 — <code>.env</code>에 <code>KIS_APP_KEY</code>/<code>KIS_APP_SECRET</code>을 설정하세요.</>
  ),
  cookie_expired: <>hogaplay 쿠키 만료 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  cookie_missing: <>hogaplay 쿠키 미설정 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  hogaplay_http_error: <>hogaplay 일시 오류 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  symbol_master_not_initialized: (
    <>
      종목 목록이 아직 다운로드되지 않았습니다 — 휴일 표시는 정상이지만 종목 검색 기능을 사용하려면 설정에서 Update하세요.
    </>
  ),
  disk_write_failed: <>디스크 쓰기 오류 — 저장 공간 또는 권한을 확인하세요.</>,
  kis_master_fetch_failed: (
    <>종목 목록 다운로드 실패 — 휴일 표시는 정상이지만 종목 검색을 쓰려면 설정에서 다시 받으세요.</>
  ),
};

/** Inline error in the range-capture form when enqueue returns HTTP 503. */
export const enqueueErrorHints: Record<UpstreamCode, ReactNode> = {
  kis_holiday_fetch_failed: (
    <>범위 캡처 시작 실패 — KIS 거래일 조회 일시 오류. 자격증명 문제가 아니니 잠시 후 재시도하세요.</>
  ),
  kis_credentials_missing: (
    <>범위 캡처 시작 실패 — KIS 자격증명 미설정. <code>.env</code>에 <code>KIS_APP_KEY</code>/<code>KIS_APP_SECRET</code>을 설정하고 재시도하세요.</>
  ),
  cookie_expired: <>범위 캡처 시작 실패 — hogaplay 쿠키 만료. 쿠키를 갱신하세요.</>,
  cookie_missing: <>범위 캡처 시작 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>범위 캡처 시작 실패 — hogaplay 응답 오류. 잠시 후 재시도하세요.</>,
  symbol_master_not_initialized: (
    <>
      범위 캡처 시작에는 종목 목록이 필요합니다 — 설정에서 Update Symbol Master 후 재시도하세요.
    </>
  ),
  disk_write_failed: <>캡처 시작 실패 — 디스크 쓰기 오류. 저장 공간 또는 권한을 확인하세요.</>,
  kis_master_fetch_failed: (
    <>종목 마스터 다운로드 실패 — 종목 목록 갱신 오류입니다. 잠시 후 재시도하세요.</>
  ),
};

/** Per-item failure display from the capture_finished SSE event. */
export const captureFinishedHints: Record<UpstreamCode, ReactNode> = {
  kis_holiday_fetch_failed: <>캡처 실패 — KIS 거래일 조회 일시 오류. 잠시 후 재시도하세요.</>,
  kis_credentials_missing: <>캡처 실패 — KIS 자격증명 미설정. <code>.env</code>를 확인하세요.</>,
  cookie_expired: <>캡처 실패 — hogaplay 쿠키 만료. 큐 일시중지됨.</>,
  cookie_missing: <>캡처 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>캡처 실패 — hogaplay 응답 오류.</>,
  symbol_master_not_initialized: (
    <>캡처 실패 — Symbol Master 미초기화. 설정에서 Update.</>
  ),
  disk_write_failed: <>캡처 실패 — 디스크 쓰기 오류. 저장 공간 또는 권한을 확인하세요.</>,
  kis_master_fetch_failed: <>캡처 실패 — 종목 마스터 다운로드 오류.</>,
};

/** Settings page → Symbol Master section. Longer-form copy than inline hints. */
export const symbolMasterSettingsHints: Record<UpstreamCode, ReactNode> = {
  kis_holiday_fetch_failed: (
    <>KIS 거래일 조회 일시 오류 — 종목 검색과는 무관합니다. 자격증명 문제가 아니니 잠시 후 재시도하세요.</>
  ),
  kis_credentials_missing: (
    <>KIS 자격증명 미설정 — 종목 검색과는 무관합니다(.mst는 무인증). <code>.env</code>에 <code>KIS_APP_KEY</code>/<code>KIS_APP_SECRET</code>을 설정하면 거래일·실시간 기능이 활성화됩니다.</>
  ),
  cookie_expired: (
    <>hogaplay 쿠키가 만료되어 종목 목록 갱신에 영향이 있을 수 있습니다 — 쿠키를 갱신하세요.</>
  ),
  cookie_missing: (
    <>hogaplay 쿠키가 설정되지 않았습니다 — 종목 목록 자체에는 영향 없지만 캡처 기능에는 필요합니다.</>
  ),
  hogaplay_http_error: (
    <>hogaplay 응답 오류 — 종목 목록 갱신과 무관할 수 있으나, 캡처 시 영향이 있습니다.</>
  ),
  symbol_master_not_initialized: (
    <>
      종목 목록이 아직 다운로드되지 않았습니다 — 아래 <strong>Update Now</strong> 버튼을 누르세요(KIS .mst 다운로드, 수 초 소요).
    </>
  ),
  disk_write_failed: (
    <>디스크 쓰기에 실패했습니다 — 저장 공간 또는 권한을 확인하세요. 디스크 파일이 손상되었을 수 있습니다.</>
  ),
  kis_master_fetch_failed: (
    <>
      KIS 종목 마스터(.mst) 다운로드에 실패했습니다 — 네트워크를 확인하고 다시
      시도하세요. 기존 디스크 파일은 보존되었습니다.
    </>
  ),
};
