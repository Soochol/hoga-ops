/**
 * `/study` 캘린더 봉에서 **저장 구간**을 표시하는 밴드.
 *
 * 넓힌 맥락 창(`studyDailyContext`) 안에서 "이 복기뷰가 저장한 구간이 어디인지" 를
 * 답하는 유일한 표시다. accent 계열 tint + 양끝 실선 — **글자는 얹지 않는다.**
 * 저장 봉·날짜를 적던 상단 라벨은 2026-08-11 사용자 요청으로 걷어냈다(캔들을 가린다);
 * 그 정보는 탭 제목과 저장뷰 드로어에 그대로 남아 있다.
 *
 * 구조는 `chart/DayBoundaryOverlay` 를 따른다 — rAF 로 합친
 * `subscribeVisibleLogicalRangeChange` + `ResizeObserver`, **`z-10`**, 그리고
 * **pane 박스 클립**.
 *
 * z 와 클립은 한 쌍이다. lightweight-charts 는 캔버스를 `z-index:1` 에 그리므로
 * `z-0` 에 두면 캔버스 뒤로 들어가 우측 거터로만 새어 나오고(#1238), 반대로 `z-10`
 * 으로 올리면 이번엔 축 거터를 **덮어** 버린다(#1272). 그래서 위로 올린 다음 pane
 * 박스로 잘라야 둘 다 해결된다.
 *
 * 좌표는 마크가 이미 캔들 ts 로 잡혀 있다(`studySavedRangeMarks` 주석 참조).
 * 여기서는 그 ts 를 축에 태우고 바 폭의 절반씩 바깥으로 넓혀 밴드 경계를 만든다.
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import type { StudySavedRangeMarks } from './studyDailyContext';

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  marks: StudySavedRangeMarks;
};

function StudySavedRangeBand({ chart, axis, marks }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const parent = containerRef.current?.parentElement;
    const ro = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && parent) ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
      ro?.disconnect();
    };
  }, [chart]);

  const ts = chart.timeScale();
  const half = Math.max(1, (ts.options().barSpacing ?? 6) / 2);
  const xFrom = ts.timeToCoordinate((axis.toVirtual(marks.fromMs) / 1000) as UTCTimestamp);
  const xTo = ts.timeToCoordinate((axis.toVirtual(marks.toMs) / 1000) as UTCTimestamp);
  // 축이 아직 안 섰거나 구간이 통째로 화면 밖이면 lwc 가 null 을 준다 — 그리지 않는다.
  if (xFrom == null || xTo == null) return null;
  const left = (xFrom as number) - half;
  const right = (xTo as number) + half;
  const width = Math.max(0, right - left);

  return (
    <div
      ref={containerRef}
      data-testid="study-saved-range-band"
      // pane 박스로 클립한다. `inset-0` 로 두면 컨테이너가 차트 전체(우측 가격축 거터 +
      // 하단 시간축)를 덮는데, `left`/`right` 는 `timeToCoordinate` 가 준 **pane 좌표계**
      // 값이라 두 좌표계의 **끝 경계가 다르다** — 구간 끝이 화면 우측에 걸치면 tint 와
      // 우측 실선이 가격 라벨 배경 위로, `top-0 bottom-0` 인 자식들은 시간축 날짜 라벨
      // 위로 새어 나온다. #1272 에서 `DayBoundaryOverlay` 가 같은 이유로 샜고 처방도 같다
      // (선보다 반투명 fill 이 더 잘 보인다).
      className="pointer-events-none absolute top-0 left-0 overflow-hidden z-10"
      style={{ width: `${ts.width()}px`, bottom: `${ts.height()}px` }}
    >
      <div
        data-testid="study-saved-range-fill"
        className="absolute top-0 bottom-0"
        style={{ left: `${left}px`, width: `${width}px`, background: 'var(--tint-selection)' }}
      />
      <div
        data-testid="study-saved-range-edge-from"
        className="absolute top-0 bottom-0 w-px"
        style={{ left: `${left}px`, background: 'var(--accent)' }}
      />
      <div
        data-testid="study-saved-range-edge-to"
        className="absolute top-0 bottom-0 w-px"
        style={{ left: `${right}px`, background: 'var(--accent)' }}
      />
    </div>
  );
}

export default memo(StudySavedRangeBand);
