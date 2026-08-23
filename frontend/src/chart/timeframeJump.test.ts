import { describe, expect, it } from 'vitest';
import {
  canPublishTimeframeJump,
  isTimeframeJumpTarget,
  jumpDateLabel,
  jumpedLogicalRange,
  resolveTimeframeJump,
  type JumpPublication,
} from './timeframeJump';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';

const DAILY_ORIGIN: SidebarCursorOrigin = {
  windowId: 'daily-window', group: 1, code: '064350', timeframe: 'D',
};

function publication(over: Partial<JumpPublication> = {}): JumpPublication {
  return {
    fromMs: 1_700_000_000_000, toMs: 1_700_086_399_999, seq: 1, origin: DAILY_ORIGIN, ...over,
  };
}

/** 게이트 기본 인자 — 받는 쪽(같은 그룹·같은 종목의 분봉 창). */
const CONSUMER = {
  myWindowId: 'minute-window',
  myTimeframe: '1m',
  myGroup: 1,
  myCode: '064350',
  allowCrossSymbol: false,
} as const;

describe('발행·소비 자격', () => {
  it('캘린더 봉만 발행하고 분봉만 받는다 — 두 집합은 서로소다', () => {
    expect(canPublishTimeframeJump('D')).toBe(true);
    expect(canPublishTimeframeJump('W')).toBe(true);
    expect(canPublishTimeframeJump('M')).toBe(true);
    expect(canPublishTimeframeJump('1m')).toBe(false);

    expect(isTimeframeJumpTarget('1m')).toBe(true);
    expect(isTimeframeJumpTarget('30m')).toBe(true);
    expect(isTimeframeJumpTarget('D')).toBe(false);
  });
});

describe('resolveTimeframeJump — 게이트', () => {
  // ⚠ 이 describe 의 첫 케이스가 **양성 대조**다. 차단 케이스만 모아 두면
  // "항상 null" 인 구현도 전부 통과한다.
  it('같은 그룹·같은 종목의 분봉 창은 받는다', () => {
    expect(resolveTimeframeJump({ publication: publication(), ...CONSUMER })).not.toBeNull();
  });

  it('발행이 없으면 null', () => {
    expect(resolveTimeframeJump({ publication: null, ...CONSUMER })).toBeNull();
  });

  it('자기 발행은 받지 않는다', () => {
    expect(resolveTimeframeJump({
      publication: publication(), ...CONSUMER, myWindowId: 'daily-window',
    })).toBeNull();
  });

  it('창번호가 다르면 받지 않는다', () => {
    expect(resolveTimeframeJump({ publication: publication(), ...CONSUMER, myGroup: 2 })).toBeNull();
  });

  it('분봉이 아닌 창은 받지 않는다 — 일봉끼리는 기간 동기화 peer 의 축이다', () => {
    expect(resolveTimeframeJump({
      publication: publication(), ...CONSUMER, myTimeframe: 'D',
    })).toBeNull();
  });

  it('분봉 발행은 받지 않는다 — 방향이 하나다', () => {
    expect(resolveTimeframeJump({
      publication: publication({ origin: { ...DAILY_ORIGIN, timeframe: '5m' } }), ...CONSUMER,
    })).toBeNull();
  });

  it('종목이 다르면 기본적으로 막고, 교차 종목을 켜면 통과한다', () => {
    const args = { publication: publication(), ...CONSUMER, myCode: '005930' };
    expect(resolveTimeframeJump(args)).toBeNull();
    expect(resolveTimeframeJump({ ...args, allowCrossSymbol: true })).not.toBeNull();
  });
});

describe('jumpedLogicalRange — 착지 기하', () => {
  it('앵커 봉을 오른쪽 여백 앞에 놓고 폭은 유지한다', () => {
    const next = jumpedLogicalRange({
      anchorIndex: 500, current: { from: 100, to: 200 }, rightOffsetBars: 13,
    });
    // 오른쪽 끝 = 앵커 + 1 + 여백. 폭 100 은 그대로.
    expect(next).toEqual({ from: 414, to: 514 });
    expect(next!.to - next!.from).toBe(200 - 100);
  });

  it('여백을 빼먹으면 앵커가 가격 라벨 밑에 깔린다 — 여백이 결과에 실제로 반영된다', () => {
    const withGutter = jumpedLogicalRange({
      anchorIndex: 500, current: { from: 100, to: 200 }, rightOffsetBars: 40,
    });
    const withoutGutter = jumpedLogicalRange({
      anchorIndex: 500, current: { from: 100, to: 200 }, rightOffsetBars: 0,
    });
    expect(withGutter!.to - withoutGutter!.to).toBe(40);
  });

  it('이미 그 자리면 null — 되쓰면 lwc 애니메이션이 재시작해 떤다', () => {
    expect(jumpedLogicalRange({
      anchorIndex: 500, current: { from: 414, to: 514 }, rightOffsetBars: 13,
    })).toBeNull();
  });

  it('폭이 0 이하이거나 값이 유한하지 않으면 null', () => {
    expect(jumpedLogicalRange({
      anchorIndex: 500, current: { from: 200, to: 200 }, rightOffsetBars: 13,
    })).toBeNull();
    expect(jumpedLogicalRange({
      anchorIndex: Number.NaN, current: { from: 100, to: 200 }, rightOffsetBars: 13,
    })).toBeNull();
  });
});

describe('jumpDateLabel', () => {
  it('올해면 연도를 접고, 다른 해면 남긴다', () => {
    expect(jumpDateLabel('20260619', '20260822')).toBe('06-19');
    expect(jumpDateLabel('20250619', '20260822')).toBe('25-06-19');
  });
});
