import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import DepthHeatmapConfig from './DepthHeatmapConfig';

/**
 * 「가격대마다 따로 최댓값」이 **부모 아래 하위 행으로** 그려지는지.
 *
 * 이 파일이 있는 이유는 호출부가 `toggleKeys` 에 **부모 키만** 넘기기 때문이다 —
 * 자식은 `IndicatorPrefRows` 가 `enabledBy` 를 보고 스스로 끌어온다. 그 배선은
 * 레지스트리(`chartPrefs`)와 렌더 사이에 걸쳐 있어서 타입이 잡아 주지 않는다:
 * `enabledBy` 를 오타 내거나 자식을 등록만 하고 부모를 안 넘기면 **행이 조용히
 * 사라지고**, 그러면 그 모드에 도달할 수단이 화면에서 없어진다.
 */
describe('DepthHeatmapConfig', () => {
  afterEach(cleanup);

  it('부모(분봉 내 최댓값 기준)와 하위(가격대마다 따로 최댓값) 토글을 함께 렌더', () => {
    render(<DepthHeatmapConfig />);
    expect(screen.getByTestId('settings-toggle-depthHeatmapIntraMax')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-depthHeatmapPerPriceMax')).toBeTruthy();
    expect(screen.getByText('가격대마다 따로 최댓값')).toBeTruthy();
  });

  it('하위 토글은 부모가 꺼져 있으면 비활성 — 값은 보존된다', () => {
    render(<DepthHeatmapConfig />);
    // 기본값은 부모 OFF. 게이트는 **값을 지우지 않고** 조작만 막는다(`IndicatorPrefRows`
    // 의 dim + disabled 규약) — 그래서 부모를 다시 켜면 자식 선택이 살아 있다.
    //
    // testid 는 행 컨테이너(`SettingsRow`)에 붙고 `disabled` 는 그 안의 스위치
    // 버튼이 갖는다 — 컨테이너에서 속성을 찾으면 **항상 false 라 통과해 버린다**.
    const row = screen.getByTestId('settings-toggle-depthHeatmapPerPriceMax');
    const child = row.querySelector('button');
    expect(child?.disabled).toBe(true);
    // 대조군 — 부모는 조작 가능해야 한다(게이트가 전부를 잠그지 않았다는 증거).
    const parentRow = screen.getByTestId('settings-toggle-depthHeatmapIntraMax');
    expect(parentRow.querySelector('button')?.disabled).toBe(false);
  });
});
