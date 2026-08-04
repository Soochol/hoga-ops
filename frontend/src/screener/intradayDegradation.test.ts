import { describe, expect, it } from 'vitest';
import { intradayDegradationText } from './intradayDegradation';

describe('intradayDegradationText', () => {
  it('강등이 없으면 배너를 만들지 않는다', () => {
    expect(intradayDegradationText([])).toBeNull();
    expect(intradayDegradationText(undefined)).toBeNull();
    expect(intradayDegradationText(['scope_universe_empty'])).toBeNull();
  });

  it('사유를 모르면 기존 총괄 문구로 폴백한다', () => {
    // 백엔드가 rows=0 만 보고 붙이는 경우(모든 종목이 invalid 등) — 실패가 아니다.
    expect(intradayDegradationText(['intraday_fallback_eod'])).toBe(
      '장중 조회 불가 · 전일 확정 데이터로 표시 중',
    );
  });

  it('유량 초과를 재시도가 의미 있는 실패로 말한다', () => {
    // ADR-0137 — 이 케이스가 "장중 조회 불가" 로 뭉개져 사용자가 처방을 알 수 없었다.
    expect(intradayDegradationText(['intraday_rate_limit_upstream', 'intraday_fallback_eod'])).toBe(
      '호출 한도 초과 · 전일 확정 데이터로 표시 중 · 잠시 후 다시 조회하세요',
    );
  });

  it('재시도가 소용없는 사유에는 재시도 안내를 붙이지 않는다', () => {
    // ADR-0137 R4 — permanent 한 조건에 "잠시 후 재시도" 를 말하면 사용자가 루프를 돈다.
    const text = intradayDegradationText(['intraday_credentials_missing', 'intraday_fallback_eod']);
    expect(text).toBe('API 자격증명 없음 · 전일 확정 데이터로 표시 중');
    expect(text).not.toContain('잠시 후');
  });

  it('배치 상한 초과는 재시도가 아니라 범위 축소를 안내한다', () => {
    expect(intradayDegradationText(['intraday_batch_limit_exceeded'])).toBe(
      '조회 상한 초과 · 전일 확정 데이터로 표시 중 · 종목 범위를 좁혀 주세요',
    );
  });

  it('부분 성공을 "조회 불가"로 말하지 않는다', () => {
    // 결과의 일부는 실제 장중 값이다 — 전부 전일 확정이라고 하면 거짓이 된다.
    const text = intradayDegradationText([
      'intraday_partial',
      'intraday_rate_limit_upstream',
      'intraday_fallback_eod',
    ]);
    expect(text).toBe('일부 종목만 장중 반영 · 호출 한도 초과 · 나머지는 전일 확정 데이터로 표시 중');
    expect(text).not.toContain('조회 불가');
  });

  it('매핑 없는 사유를 조용히 버리지 않는다', () => {
    // R6 — 화이트리스트 렌더가 백엔드 사유 46개 중 25개를 없었던 일로 만들었다.
    // 못생긴 표시가 침묵보다 낫다.
    expect(intradayDegradationText(['intraday_brand_new_reason'])).toBe(
      '장중 조회 불가(intraday_brand_new_reason) · 전일 확정 데이터로 표시 중',
    );
  });

  it('상태 신호를 원인으로 오해하지 않는다', () => {
    // intraday_quote_invalid 는 "일부 종목의 호가가 이상하다" 는 데이터 품질 신호지
    // 조회 실패 원인이 아니다. 이걸 원인으로 잡으면 문구가 엉뚱해진다.
    expect(intradayDegradationText(['intraday_quote_invalid', 'intraday_fallback_eod'])).toBe(
      '장중 조회 불가 · 전일 확정 데이터로 표시 중',
    );
  });
});
