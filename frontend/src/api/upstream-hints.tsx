/** Per-surface user-facing copy keyed by UpstreamCode (ADR-0009).
 *
 *  Adding a new UpstreamCode value to types.ts triggers TypeScript errors
 *  in every map below that lacks the new key — that's the structural payoff.
 */
import type { ReactNode } from 'react';
import type { UpstreamCode } from './types';

/** Empty-state hint shown in SymbolSearch when the Symbol Master is empty. */
export const symbolSearchHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      KRX 자격증명이 없습니다 — repo 루트 <code>.env</code>에{' '}
      <code>KRX_ID</code>, <code>KRX_PW</code>를 설정한 뒤 아래{' '}
      <strong>Refresh</strong> 버튼을 누르세요.
    </>
  ),
  krx_fetch_failed: (
    <>
      KRX에서 종목 목록을 가져오지 못했습니다 — <code>.env</code>의 자격증명을
      확인하고 잠시 후 Refresh를 시도하세요.
    </>
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
};

/** Banner above the calendar grid (informational; data still renders). */
export const calendarHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      KRX 자격증명이 없어 휴일 표시가 정확하지 않을 수 있습니다 —{' '}
      <code>.env</code>에 <code>KRX_ID</code>, <code>KRX_PW</code>를 설정하세요.
    </>
  ),
  krx_fetch_failed: (
    <>KRX에서 거래일 데이터를 가져오지 못해 휴일 표시가 정확하지 않을 수 있습니다.</>
  ),
  cookie_expired: <>hogaplay 쿠키 만료 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  cookie_missing: <>hogaplay 쿠키 미설정 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  hogaplay_http_error: <>hogaplay 일시 오류 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  symbol_master_not_initialized: (
    <>
      종목 목록이 아직 다운로드되지 않았습니다 — 휴일 표시는 정상이지만 종목 검색 기능을 사용하려면 설정에서 Update하세요.
    </>
  ),
};

/** Inline error in the range-capture form when enqueue returns HTTP 503. */
export const enqueueErrorHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      범위 캡처 시작 실패 — KRX 자격증명이 필요합니다. <code>.env</code>에{' '}
      <code>KRX_ID</code>, <code>KRX_PW</code>를 설정하세요.
    </>
  ),
  krx_fetch_failed: (
    <>범위 캡처 시작 실패 — KRX 거래일 데이터를 가져올 수 없습니다. 잠시 후 재시도하세요.</>
  ),
  cookie_expired: <>범위 캡처 시작 실패 — hogaplay 쿠키 만료. 쿠키를 갱신하세요.</>,
  cookie_missing: <>범위 캡처 시작 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>범위 캡처 시작 실패 — hogaplay 응답 오류. 잠시 후 재시도하세요.</>,
  symbol_master_not_initialized: (
    <>
      범위 캡처 시작에는 종목 목록이 필요합니다 — 설정에서 Update Symbol Master 후 재시도하세요.
    </>
  ),
};

/** Per-item failure display from the capture_finished SSE event. */
export const captureFinishedHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>캡처 실패 — KRX 자격증명 필요.</>,
  krx_fetch_failed: <>캡처 실패 — KRX 응답 오류.</>,
  cookie_expired: <>캡처 실패 — hogaplay 쿠키 만료. 큐 일시중지됨.</>,
  cookie_missing: <>캡처 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>캡처 실패 — hogaplay 응답 오류.</>,
  symbol_master_not_initialized: (
    <>캡처 실패 — Symbol Master 미초기화. 설정에서 Update.</>
  ),
};

/** Settings page → Symbol Master section. Longer-form copy than inline hints. */
export const symbolMasterSettingsHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      KRX 자격증명이 없어 갱신할 수 없습니다 — repo 루트 <code>.env</code>에{' '}
      <code>KRX_ID</code>, <code>KRX_PW</code>를 설정한 뒤 다시 시도하세요.
    </>
  ),
  krx_fetch_failed: (
    <>
      KRX에서 종목 목록을 가져오지 못했습니다 — 자격증명 또는 네트워크를 확인하고 잠시 후 다시 시도하세요. 디스크 파일은 보존되었습니다.
    </>
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
      종목 목록이 아직 다운로드되지 않았습니다 — 아래 <strong>Update Now</strong> 버튼을 누르면 ~30~120초가 소요됩니다.
    </>
  ),
};
