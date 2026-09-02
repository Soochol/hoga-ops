/**
 * 기간 점프 소비 — **기준일**(창의 데이터 우단)과 칩 상태.
 *
 * 종전 이 파일은 착지·래치·중단·백필 목표를 쟀다. 그 넷은 「목적지까지 걸어가는」
 * 구조의 부속이었고, 우단을 목적지로 옮기면서 함께 사라졌다(모듈 헤더 참조).
 * 지금 재는 것은 둘이다 — **어떤 명령이 우단을 옮기는가**, 그리고 **칩이 무엇을
 * 말하는가**.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { minuteJumpChipState, useMinuteJumpTarget, type MinuteJumpTarget } from './useTimeframeJump';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import { useLivePageStore } from '../state/livePage';

const DAILY_ORIGIN: SidebarCursorOrigin = {
  windowId: 'daily-window', group: 1, code: '064350', timeframe: 'D',
};

const TODAY = '20260822';
/** KST 09:00 = UTC 00:00 — 날짜 변환이 경계에 걸리지 않는 시각을 고른다. */
function kstMs(yyyymmdd: string, hour = 12): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return Date.UTC(y, m - 1, d, hour - 9);
}

let latest: MinuteJumpTarget;

function Consumer(props: {
  myGroup?: number | null;
  myTimeframe?: '1m' | 'D';
  enabled?: boolean;
  myCode?: string | null;
  /** ⚠ 종목 수명 스펙은 **`true`(공장값)로** 재야 한다 — 아래 그 describe 참조. */
  allowCrossSymbol?: boolean;
  mySymbolKey?: string | null;
}) {
  const code = props.myCode === undefined ? '064350' : props.myCode;
  latest = useMinuteJumpTarget({
    enabled: props.enabled ?? true,
    myWindowId: 'minute-window',
    myTimeframe: props.myTimeframe ?? '1m',
    myGroup: props.myGroup === undefined ? 1 : props.myGroup,
    myCode: code,
    allowCrossSymbol: props.allowCrossSymbol ?? false,
    // 지정이 없으면 코드에서 만든다 — 기존 스펙들이 이 인자를 몰라도 되게.
    mySymbolKey: props.mySymbolKey === undefined
      ? (code === null ? null : `stock:${code}`)
      : props.mySymbolKey,
    todayKst: TODAY,
  });
  return null;
}

/**
 * 반환값은 **같은 창을 다시 그리는** 함수다 — 종목 교체를 재려면 이것이어야 한다.
 * `render` 를 한 번 더 부르면 두 번째 트리가 생기고, 그 창은 baseline seq 를 새로
 * 잡아(이미 있는 발행을 무시) 축이 통째로 흐려진다.
 */
function mount(props: Parameters<typeof Consumer>[0] = {}) {
  const { rerender } = render(<Consumer {...props} />);
  return (next: Parameters<typeof Consumer>[0]) => rerender(<Consumer {...next} />);
}

/** 발행 창이 보내는 것과 같은 모양 — 칸의 시작·포함 상한. */
function publish(fromDate: string, toDate: string, origin = DAILY_ORIGIN) {
  act(() => {
    useLiveCursorStore.getState().requestTimeframeJump(kstMs(fromDate, 9), kstMs(toDate, 15), origin);
  });
}

beforeEach(() => {
  useLiveCursorStore.setState({ jumpRequest: null });
  useLivePageStore.getState().resetHistoricalRange();
});
afterEach(cleanup);

describe('기준일 — 창의 데이터 우단을 목적지로 옮긴다', () => {
  it('점프 전에는 라이브 창이다(기준일 없음)', () => {
    mount();
    expect(latest.asOfDate).toBeNull();
    expect(latest.viewSeg).toBeNull();
    expect(latest.date).toBeNull();
  });

  it('과거로 점프하면 그 날이 우단이 된다', () => {
    mount();
    publish('20260817', '20260821');
    expect(latest.asOfDate).toBe('20260821');
    expect(latest.date).toBe('20260821');
  });

  // 칸 시작(`fromMs`)은 종전의 **백필 목표**였다. 지금은 창이 우단에서 왼쪽으로
  // 자라므로 시작일을 지정하면 좌측 팬을 얼리는 저장뷰가 된다 — 안 쓰는 것이 계약이다.
  it('칸 **시작**은 쓰지 않는다 — 우단만 옮긴다', () => {
    mount();
    publish('20260601', '20260821');
    expect(latest.asOfDate).toBe('20260821');
  });

  // 주·월 칸의 상한은 달력상의 칸 끝이라 미래일 수 있다(8월 칸 → 08-31).
  // 미래를 우단으로 보내면 백엔드가 422(DATE_IN_FUTURE)를 낸다.
  it('상한이 미래면 오늘로 클램프한다', () => {
    mount();
    publish('20260803', '20260831');
    expect(latest.date).toBe(TODAY);
  });

  // 라이브 창이 이미 그 구간이다. 기준일을 세우면 SSE 구독만 끊겨 실시간이 죽는다.
  it('목적지가 오늘이면 데이터 레버를 세우지 않는다 — 착지는 여전히 한다', () => {
    mount();
    publish('20260818', TODAY);
    expect(latest.asOfDate).toBeNull();
    expect(latest.viewSeg).not.toBeNull();
  });
});

describe('착지 — viewSeg 가 차트 remount 를 유발한다', () => {
  it('목적지가 갈리면 조각도 갈린다', () => {
    mount();
    publish('20260817', '20260821');
    const first = latest.viewSeg;
    publish('20260810', '20260814');
    expect(latest.viewSeg).not.toBe(first);
  });

  // 종전 ↻ 의 역할. 목적지만 섞으면 두 번째 누름이 값 동일로 묻혀 착지가 안 일어난다.
  it('**같은 목적지**로 다시 눌러도 조각이 갈린다 (seq)', () => {
    mount();
    publish('20260817', '20260821');
    const first = latest.viewSeg;
    publish('20260817', '20260821');
    expect(latest.viewSeg).not.toBe(first);
  });
});

describe('게이트', () => {
  it('창번호가 다르면 아무 일도 없다', () => {
    mount({ myGroup: 2 });
    publish('20260817', '20260821');
    expect(latest.asOfDate).toBeNull();
    expect(latest.viewSeg).toBeNull();
  });

  it('캘린더 봉 창은 받지 않는다 — 발행 쪽이다', () => {
    mount({ myTimeframe: 'D', enabled: false });
    publish('20260817', '20260821');
    expect(latest.asOfDate).toBeNull();
  });

  // 슬롯에 남아 있던 옛 명령을 새로 연 창이 적용하면 그 창의 초기 배치와 싸운다.
  it('마운트 전에 있던 발행은 무시한다 (baseline seq)', () => {
    act(() => {
      useLiveCursorStore.getState().requestTimeframeJump(
        kstMs('20260817', 9), kstMs('20260821', 15), DAILY_ORIGIN,
      );
    });
    mount();
    expect(latest.asOfDate).toBeNull();
  });
});

describe('해제 — × 는 이 창만 푼다', () => {
  it('기준일과 조각이 함께 내려간다', () => {
    mount();
    publish('20260817', '20260821');
    expect(latest.asOfDate).toBe('20260821');
    act(() => latest.clear());
    expect(latest.asOfDate).toBeNull();
    expect(latest.viewSeg).toBeNull();
  });

  // 슬롯은 그룹 공용이라 지우면 **다른 분봉 창의 칩까지** 사라진다.
  it('슬롯은 지우지 않는다 — 해제는 창의 로컬 사실이다', () => {
    mount();
    publish('20260817', '20260821');
    act(() => latest.clear());
    expect(useLiveCursorStore.getState().jumpRequest).not.toBeNull();
  });

  it('푼 뒤 새 점프는 다시 받는다', () => {
    mount();
    publish('20260817', '20260821');
    act(() => latest.clear());
    publish('20260810', '20260814');
    expect(latest.asOfDate).toBe('20260814');
  });
});

describe('수명 — 종목이 갈리면 이 창의 점프가 풀린다', () => {
  // ⚠ **`allowCrossSymbol: true` 로 잰다**(공장값). `false` 면 기존 게이트
  // (`resolveTimeframeJump` 의 「발행자 vs 나」 조건)가 **공범**이라 수명 코드를 통째로
  // 지워도 이 스펙들이 초록으로 통과한다 — red 는 대상 코드가 유일한 기여자일 때만 뜬다.
  const CROSS = { allowCrossSymbol: true } as const;

  it('종목이 갈리면 기준일과 조각이 함께 내려간다', () => {
    const rerender = mount({ ...CROSS, myCode: '064350' });
    publish('20260817', '20260821');
    expect(latest.asOfDate).toBe('20260821');
    rerender({ ...CROSS, myCode: '005930' });
    expect(latest.asOfDate).toBeNull();
    expect(latest.viewSeg).toBeNull();
    expect(latest.date).toBeNull();
  });

  // 비교만 하면 값이 다시 같아져 칩이 되살아난다. 해제는 **못 박는** 것이다.
  it('원래 종목으로 돌아와도 되살아나지 않는다 (A→B→A)', () => {
    const rerender = mount({ ...CROSS, myCode: '064350' });
    publish('20260817', '20260821');
    rerender({ ...CROSS, myCode: '005930' });
    rerender({ ...CROSS, myCode: '064350' });
    expect(latest.asOfDate).toBeNull();
  });

  // 종목이 그대로면 재렌더만으로 풀려서는 안 된다 — SSE 틱마다 재렌더가 온다.
  it('같은 종목이면 재렌더에 살아남는다', () => {
    const rerender = mount({ ...CROSS, myCode: '064350' });
    publish('20260817', '20260821');
    rerender({ ...CROSS, myCode: '064350' });
    rerender({ ...CROSS, myCode: '064350' });
    expect(latest.asOfDate).toBe('20260821');
  });

  it('푼 뒤 새 점프는 다시 받는다 — × 와 같은 계약', () => {
    const rerender = mount({ ...CROSS, myCode: '064350' });
    publish('20260817', '20260821');
    rerender({ ...CROSS, myCode: '005930' });
    publish('20260810', '20260814', { ...DAILY_ORIGIN, code: '005930' });
    expect(latest.asOfDate).toBe('20260814');
  });

  // 슬롯은 그룹 공용이라 지우면 다른 분봉 창의 칩까지 사라진다(× 와 같은 규율).
  it('슬롯은 지우지 않는다', () => {
    const rerender = mount({ ...CROSS, myCode: '064350' });
    publish('20260817', '20260821');
    rerender({ ...CROSS, myCode: '005930' });
    expect(useLiveCursorStore.getState().jumpRequest).not.toBeNull();
  });

  // 지수 창은 `myCode` 가 설계상 `null` 이라 그 축으로는 교체가 안 보인다.
  it('지수 창도 본다 — KOSPI→KOSDAQ (myCode 는 둘 다 null)', () => {
    const rerender = mount({ ...CROSS, myCode: null, mySymbolKey: 'index:KOSPI' });
    publish('20260817', '20260821');
    expect(latest.asOfDate).toBe('20260821');
    rerender({ ...CROSS, myCode: null, mySymbolKey: 'index:KOSDAQ' });
    expect(latest.asOfDate).toBeNull();
  });
});

describe('창의 시작일 리셋', () => {
  // 팬한 적 없는 창은 시작일이 오늘−5거래일쯤이라, 두 달 전으로 점프하면
  // `from > to` 가 된다. 라이브로 돌아올 때는 반대로 깊어진 시작일이 남는다.
  it('기준일이 서면 리셋한다', () => {
    mount();
    act(() => { useLivePageStore.getState().extendHistoricalRange('20260701'); });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260701');
    publish('20260817', '20260821');
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('풀 때도 리셋한다', () => {
    mount();
    publish('20260817', '20260821');
    act(() => { useLivePageStore.getState().extendHistoricalRange('20260601'); });
    act(() => latest.clear());
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  // deps 만으로 걸면 첫 커밋에서도 발화해 창이 복원한 시작일을 지운다 —
  // 점프와 무관한 창까지 매번 초기 폭으로 돌아간다.
  it('마운트에서는 부르지 않는다', () => {
    act(() => { useLivePageStore.getState().extendHistoricalRange('20260701'); });
    mount();
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260701');
  });
});

describe('칩 상태', () => {
  const base = {
    date: '20260821', floorDate: '20251217', isLoading: false, lastCandleDate: '20260821',
  };

  it('점프가 없으면 칩도 없다', () => {
    expect(minuteJumpChipState({ ...base, date: null })).toBeNull();
  });

  it('불러오는 중이면 seeking', () => {
    expect(minuteJumpChipState({ ...base, isLoading: true })?.status).toBe('seeking');
  });

  it('받아 왔고 봉이 있으면 landed', () => {
    expect(minuteJumpChipState(base)?.status).toBe('landed');
  });

  // 「받아 봤는데 없다」를 seeking 에 뭉치면 칩이 영원히 "불러오는 중" 을 표시한다.
  it('받아 왔는데 봉이 없으면 no-data — seeking 에 뭉치지 않는다', () => {
    expect(minuteJumpChipState({ ...base, lastCandleDate: null })?.status).toBe('no-data');
  });

  /**
   * #1506 의 계약 — **착지하면 목적지가 아니라 앉은 봉의 날짜를 말한다.**
   *
   * 주·월 칸의 상한은 달력상의 칸 끝이라 비거래일일 수 있다(주봉 칸이면 일요일).
   * 우단이 그 날로 가도 마지막 봉은 그 앞 거래일이므로, 상한을 계속 말하면 **차트가
   * 보여주지 않는 날을 이름 붙이는 칩**이 된다(실측 2026-08-23: 주봉 상한 08-23(일),
   * 착지 08-21).
   */
  it('착지 날짜는 **앉은 봉**이다 — 목적지 상한이 아니라', () => {
    const s = minuteJumpChipState({ ...base, date: '20260823', lastCandleDate: '20260821' });
    expect(s?.status).toBe('landed');
    expect(s?.date).toBe('20260821');
  });

  // 착지 **전**에는 앉은 봉이 없으므로 목적지를 말한다(그때는 그것이 유일한 사실이다).
  it('착지 전에는 목적지를 말한다', () => {
    const s = minuteJumpChipState({ ...base, date: '20260823', isLoading: true });
    expect(s?.date).toBe('20260823');
  });

  it('하한 밖이면 out-of-retention 이고 **그 창의 하한 날짜**를 함께 낸다', () => {
    const s = minuteJumpChipState({ ...base, date: '20250101' });
    expect(s?.status).toBe('out-of-retention');
    expect(s?.floorDate).toBe('20251217');
  });

  // 디스크 모드는 하한을 모른다 — 모르는 것을 못 간다고 말하지 않는다.
  it('하한이 null 이면 같은 날짜라도 막지 않는다', () => {
    const s = minuteJumpChipState({ ...base, date: '20250101', floorDate: null });
    expect(s?.status).toBe('landed');
  });

  // 하한 판정이 로딩보다 **먼저**다: 영영 안 올 것을 "불러오는 중" 으로 표시하면
  // 사용자가 기다린다.
  it('하한 밖이면 로딩 중이어도 out-of-retention 이다', () => {
    const s = minuteJumpChipState({ ...base, date: '20250101', isLoading: true });
    expect(s?.status).toBe('out-of-retention');
  });
});

describe('점프 채널은 크로스헤어 정리에 지워지지 않는다 (#1506)', () => {
  // 발행 창이 봉을 바꾸면 자기 차트 정리 경로를 탄다 — 그때 점프까지 지워지면 안 된다.
  it('발행 창의 커서 정리가 기준일을 지우지 않는다', () => {
    mount();
    publish('20260817', '20260821');
    act(() => { useLiveCursorStore.getState().resetCursorFrom(DAILY_ORIGIN.windowId); });
    expect(latest.asOfDate).toBe('20260821');
  });
});

/** 발행 슬롯의 seq 는 단조 증가여야 한다 — 되감기면 새 발행이 옛 baseline 에 걸려 죽는다. */
describe('seq 단조성 (#1508)', () => {
  it('슬롯이 통째로 비워진 뒤의 발행도 받는다', () => {
    mount();
    publish('20260817', '20260821');
    act(() => { useLiveCursorStore.setState({ jumpRequest: null }); });
    publish('20260810', '20260814');
    expect(latest.asOfDate).toBe('20260814');
  });
});

/** 콘솔 경고를 실패로 승격하지는 않지만, 훅이 조용히 죽는 것은 잡는다. */
afterEach(() => vi.restoreAllMocks());
