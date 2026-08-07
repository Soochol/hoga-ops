import { describe, expect, it } from 'vitest';
import { deriveSourceBadge, GAP_FLOOR_MS } from './sourceBadge';
import type { RangeSegment } from '../api/types';

const seg = (date: string, source?: string, gapMs?: number | null): RangeSegment => ({
  date,
  session_open_ms: 1,
  session_close_ms: 2,
  ...(source ? { source: source as RangeSegment['source'] } : {}),
  ...(gapMs === undefined ? {} : { gap_ms: gapMs }),
});

const MIN = 60_000;

describe('deriveSourceBadge', () => {
  it('기본 소스만이면 침묵한다 — 항상 띄우면 정보가 아니라 배경이 된다', () => {
    expect(deriveSourceBadge([seg('20260806', 'kiwoom_live')])).toBeNull();
    expect(deriveSourceBadge([seg('1', 'kiwoom_live'), seg('2', 'kiwoom_live')])).toBeNull();
  });

  it('세그먼트가 없으면 말할 것이 없다', () => {
    expect(deriveSourceBadge([])).toBeNull();
    expect(deriveSourceBadge(undefined)).toBeNull();
  });

  it('기본이 아닌 소스를 알린다', () => {
    expect(deriveSourceBadge([seg('20260701', 'hogaplay')])).toBe('hogaplay');
  });

  it('섞이면 기본이 아닌 것만 나열한다 — 팬으로 과거가 붙는 흔한 경우', () => {
    // 전부 나열하면 줄이 길어져 차트를 가린다. 눈여겨볼 대상은 기본이 아닌 쪽이다.
    const badge = deriveSourceBadge([
      seg('20260701', 'hogaplay'),
      seg('20260806', 'kiwoom_live'),
    ]);
    expect(badge).toBe('hogaplay');
  });

  it('같은 소스가 여러 날 있어도 한 번만 나온다', () => {
    expect(deriveSourceBadge([seg('1', 'hogaplay'), seg('2', 'hogaplay')])).toBe('hogaplay');
  });

  // ⚠ 이 폴백이 없으면 백엔드 SourceName 드리프트가 `undefined.label` 크래시가 되고,
  // 그 크래시가 차트 전체를 언마운트시킨 전례가 있다(리뷰 C2 · #975 주석).
  it('모르는 소스도 크래시하지 않고 원문을 보여준다', () => {
    expect(deriveSourceBadge([seg('1', 'brand_new_source')])).toBe('brand_new_source');
  });

  it('source 가 없는 구버전 세그먼트는 무시한다', () => {
    expect(deriveSourceBadge([seg('1')])).toBeNull();
  });
});

describe('deriveSourceBadge — 결손 트리거', () => {
  it('기본 소스여도 결손이 크면 알린다 — 이 배지가 만들어진 이유', () => {
    // 2026-08-06 000660: 키움이 정규장 6.5시간 중 5시간 31분을 놓쳤는데 사다리
    // 1순위라 배지가 침묵했다. 사용자가 화면을 보고 직접 발견할 때까지 무증상이었다.
    expect(deriveSourceBadge([seg('20260806', 'kiwoom_live', 19_843_000)]))
      .toBe('키움 WS · 결손 5시간 31분');
  });

  it('하한 미만이면 침묵한다 — 건강일 잡음을 배경으로 만들지 않는다', () => {
    expect(deriveSourceBadge([seg('1', 'kiwoom_live', GAP_FLOOR_MS - 1)])).toBeNull();
    expect(deriveSourceBadge([seg('1', 'kiwoom_live', 0)])).toBeNull();
  });

  it('하한 경계는 포함이다', () => {
    expect(deriveSourceBadge([seg('1', 'kiwoom_live', GAP_FLOOR_MS)])).toBe('키움 WS · 결손 5분');
  });

  // ⚠ 계약의 핵심: 모르는 것을 "없음" 으로 바꾸면 배지가 조용해진다(#1183 드리프트 패턴).
  it('gap_ms 없음(구 백엔드)은 0 이 아니다 — 결손 트리거가 걸리지 않는다', () => {
    expect(deriveSourceBadge([seg('1', 'kiwoom_live')])).toBeNull();
    expect(deriveSourceBadge([seg('1', 'kiwoom_live', null)])).toBeNull();
    // 소스 트리거는 gap 정보와 무관하게 그대로 동작한다.
    expect(deriveSourceBadge([seg('1', 'hogaplay', null)])).toBe('hogaplay');
  });

  it('일부만 아는 경우 아는 값만 합산한다', () => {
    const badge = deriveSourceBadge([
      seg('1', 'kiwoom_live', 4 * MIN),
      seg('2', 'kiwoom_live', null),
      seg('3', 'kiwoom_live', 4 * MIN),
    ]);
    expect(badge).toBe('키움 WS · 결손 8분');
  });

  it('소스와 결손이 함께 걸리면 한 줄에 낸다', () => {
    expect(deriveSourceBadge([seg('20260806', 'hogaplay', 12 * MIN)]))
      .toBe('hogaplay · 결손 12분');
  });

  it('결손만으로 뜰 때도 어느 소스가 비었는지 밝힌다', () => {
    // 소스 트리거는 안 걸렸지만(기본 소스) 배지는 이미 떴다 — 정보를 아낄 이유가 없다.
    expect(deriveSourceBadge([seg('1', 'kiwoom_live', 90 * MIN)]))
      .toBe('키움 WS · 결손 1시간 30분');
  });

  it('정각 시간은 분을 생략한다', () => {
    expect(deriveSourceBadge([seg('1', 'kiwoom_live', 120 * MIN)]))
      .toBe('키움 WS · 결손 2시간');
  });
});
