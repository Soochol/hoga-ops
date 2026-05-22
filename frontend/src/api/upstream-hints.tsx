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
};

/** Per-item failure display from the capture_finished SSE event. */
export const captureFinishedHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>캡처 실패 — KRX 자격증명 필요.</>,
  krx_fetch_failed: <>캡처 실패 — KRX 응답 오류.</>,
  cookie_expired: <>캡처 실패 — hogaplay 쿠키 만료. 큐 일시중지됨.</>,
  cookie_missing: <>캡처 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>캡처 실패 — hogaplay 응답 오류.</>,
};
