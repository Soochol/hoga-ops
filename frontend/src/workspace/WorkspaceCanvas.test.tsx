/**
 * 코어 캔버스의 **재렌더 경계** 계약.
 *
 * `WorkspaceWindowItem`(소비처)의 주석은 오래전부터 "드래그 중엔 rect 가 바뀐 창
 * (드래그+follower)만 재렌더된다" 를 약속했지만, 그 성질을 재는 테스트가 **한 번도
 * 없었다**. 그래서 `rectOf` 가 호출마다 새 rect 객체를 내는 동안에도 아무도 몰랐다 —
 * `preview` 는 드래그 참여 창만 담으므로 나머지 창은 전부 그 경로로 떨어져 memo 가
 * 매 pointermove(≈60Hz) bail 실패했다.
 *
 * `/live` 에서 그 서브트리는 `ChartWindowInner → useLiveChartData → useLiveBundle →
 * LiveChartRoot` 이고 창 수에 비례한다. 즉 "창을 여러 개 띄우면 드래그가 끌린다" 의
 * 직접 원인이고, **렌더 횟수로만 잡힌다**(화면은 똑같이 나온다).
 *
 * 코어에 두는 이유: `/live` 와 `/study` 가 같은 코어를 쓰므로 계약도 한 곳에서 잰다.
 *
 * **범위: 이 테스트는 `rect` 축만 잰다.** memo 경계는 `itemCtx` 신원으로도 똑같이 죽는데,
 * 그 축은 여기서 재지 않는다 — `itemCtx` 는 **소비처(부모)** 가 만들고 코어의 드래그 state 는
 * **코어 안**에 있어서, pointermove 는 코어만 재렌더하고 부모를 건드리지 않기 때문이다
 * (즉 드래그 중 ctx 는 구조적으로 안정이다). 확인한 두 소비처:
 *   - `live/workspace/WorkspaceCanvas.tsx:225` deps `[groupSymbols, palette, closeWindow,
 *     onTogglePalette, onPickGroup]` — 전부 페이지 수준, 틱 빈도 아님.
 *   - `studyViews/StudyWorkspaceCanvas.tsx:170` deps 도 전부 페이지 수준.
 * 단 하나의 예외는 **드래그 시작 1회**다: `onDragStart` 가 열린 팔레트를 닫으므로
 * (`live/.../WorkspaceCanvas.tsx:68`) 팔레트가 열려 있었다면 그 순간 ctx 가 한 번 바뀌어
 * 전 창이 한 번 재렌더된다. **의도된 상태 변화이고 pointermove 마다가 아니므로 결함이
 * 아니다** — 다만 이 테스트가 그 경로를 재현하지 않는다는 점(여기선 ctx 가 상수)을 밝혀,
 * "재렌더 0" 이라는 결과가 무엇에 대한 0 인지 오독되지 않게 한다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { memo } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { WorkspaceCanvasCore, type WindowItemProps, type WorkspaceWindowLike } from './WorkspaceCanvas';

type W = WorkspaceWindowLike;
type Ctx = Record<string, never>;

/** 창 id → 렌더 횟수. 모듈 스코프라 memo 경계를 흔들지 않는다. */
const renderCounts = new Map<string, number>();

/**
 * 실제 항목 컴포넌트와 **같은 모양의 대역** — `memo` + 비교자 없음(기본 얕은 비교).
 * 이 두 성질이 결함의 전제였으므로 대역도 그대로 재현해야 테스트가 의미를 갖는다.
 */
const CountingItem = ({ win, rect, onHandleDown }: WindowItemProps<W, Ctx>) => {
  renderCounts.set(win.id, (renderCounts.get(win.id) ?? 0) + 1);
  return (
    <div
      data-testid={`win-${win.id}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <button
        type="button"
        data-testid={`handle-${win.id}`}
        onPointerDown={(e) => onHandleDown(e, win.id, 'move')}
      >
        drag
      </button>
    </div>
  );
};
// memo 로 감싼 뒤 넘긴다 — 코어의 계약은 "항목이 memo 면 무관한 창은 안 돈다" 이다.
const MemoCountingItem = memo(CountingItem);

// props 신원을 렌더 간 고정 — 코어는 내부 setState 로만 재렌더되므로 부모가 새 배열을
// 만들지 않는 실제 상황(zustand 셀렉터가 같은 배열을 반환)과 같아진다.
const WINDOWS: W[] = [
  { id: 'a', rect: { x: 0, y: 0, w: 0.3, h: 0.3 } },
  { id: 'b', rect: { x: 0.4, y: 0, w: 0.3, h: 0.3 } },
  { id: 'c', rect: { x: 0.4, y: 0.4, w: 0.3, h: 0.3 } },
];
// 마지막 = 최상단(포커스). **드래그 대상을 이미 포커스된 창으로 잡는다** — 그래야
// `focusWindow` 가 zOrder 를 바꾸지 않아 `focused`/`zIndex` 축이 결과에 섞이지 않는다
// (움직이는 변수를 rect 하나로 고정).
const Z_ORDER = ['b', 'c', 'a'];
const ITEM_CTX: Ctx = {};

function renderCanvas() {
  return render(
    <WorkspaceCanvasCore<W, Ctx>
      windows={WINDOWS}
      zOrder={Z_ORDER}
      focusWindow={() => {}}
      setWindowRects={() => {}}
      windowItem={MemoCountingItem}
      itemCtx={ITEM_CTX}
    />,
  );
}

describe('WorkspaceCanvasCore — 드래그 중 재렌더 경계', () => {
  beforeEach(() => {
    renderCounts.clear();
  });

  it('드래그에 참여하지 않은 창은 pointermove 동안 한 번도 재렌더되지 않는다', () => {
    const { getByTestId } = renderCanvas();
    const canvas = getByTestId('win-a').parentElement!;
    const baseline = new Map(renderCounts);
    expect(baseline.get('b')).toBeGreaterThan(0);   // 초기 렌더는 있었다(0건 순회 방지)

    act(() => {
      fireEvent.pointerDown(getByTestId('handle-a'), { pointerId: 1, clientX: 10, clientY: 10 });
    });
    for (const [dx, dy] of [[8, 4], [16, 9], [24, 15]]) {
      act(() => {
        fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: 10 + dx, clientY: 10 + dy });
      });
    }

    // 참여 창(a)은 rect 가 실제로 바뀌므로 재렌더가 **있어야** 한다 — 이 단언이 없으면
    // "드래그가 아예 발화하지 않아서 전부 0" 인 위양성과 구별되지 않는다.
    expect(renderCounts.get('a')!).toBeGreaterThan(baseline.get('a')!);
    // 비참여 창(b·c)은 증가 0.
    expect(renderCounts.get('b')).toBe(baseline.get('b'));
    expect(renderCounts.get('c')).toBe(baseline.get('c'));
  });

  it('같은 rect 를 두 번 읽으면 같은 객체다 — memo 가 기댈 수 있는 신원', () => {
    const seen: unknown[] = [];
    const Probe = (props: WindowItemProps<W, Ctx>) => {
      if (props.win.id === 'b') seen.push(props.rect);
      return <div data-testid={`win-${props.win.id}`} />;
    };
    const { getByTestId, rerender } = render(
      <WorkspaceCanvasCore<W, Ctx>
        windows={WINDOWS}
        zOrder={Z_ORDER}
        focusWindow={() => {}}
        setWindowRects={() => {}}
        windowItem={Probe}
        itemCtx={ITEM_CTX}
      />,
    );
    // 부모 재렌더(같은 props)에서도 rect 신원이 유지돼야 한다 — 이게 깨지면 memo 를
    // 붙여도 소용이 없다.
    rerender(
      <WorkspaceCanvasCore<W, Ctx>
        windows={WINDOWS}
        zOrder={Z_ORDER}
        focusWindow={() => {}}
        setWindowRects={() => {}}
        windowItem={Probe}
        itemCtx={ITEM_CTX}
      />,
    );
    expect(getByTestId('win-b')).toBeTruthy();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(seen[seen.length - 1]);
  });
});
