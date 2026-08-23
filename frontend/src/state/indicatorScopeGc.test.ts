import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore } from './livePage';
import { useChartPrefsStore } from './chartPrefs';
import {
  dropIndicatorScopesForRemovedWindows,
  dropIndicatorScopesForWindows,
  seedIndicatorScopeForWindow,
} from './indicatorScopeGc';
import { FACTORY_INDICATOR_SETTINGS } from './indicatorSettingsV2';

/**
 * 창 지표 스코프의 시드·회수 (ADR-0152).
 *
 * **막는 방향**: 창이 사라졌는데 설정이 남는 것(닿을 수 없는 쓰레기)과, 창이
 * 생겼는데 설정이 없는 것(페이지 세트를 공유 → 기능이 절반만 동작).
 *
 * **못 보는 것**: 크로스탭 회수 과잉. 두 브라우저 탭이 같은 창 id 를 갖는 상황은
 * 이 유닛 테스트의 사거리 밖이고, 모듈 주석에 감수한 트레이드오프로 적혀 있다.
 *
 * **등록 의존**: 없다 — 호출부(워크스페이스 스토어)가 이 함수를 부르는지는
 * `windowView.scope.test.tsx` 의 창 닫기·스냅샷 케이스가 잰다.
 *
 * ⚠ 접두사가 전부 `'live'` 다 — `IndicatorPageScope` 는 아직 `'live' | 'study'` 지만
 * `/study` 삭제(2026-08-23)로 **두 번째 값을 쓰는 코드가 없다**. 여기 있던 `/study`
 * 창 닫기 게이트 케이스(`canCloseStudyWindow` 가 마지막 차트 창을 거부하는 no-op 에서
 * 회수하면 안 된다)는 그 불변식이 `/study` 전용이라 함께 사라졌다 — `/live` 의
 * `closeWindow` 에는 그 게이트가 애초에 없다(확인 완료).
 */

const KEY = 'live:w1';

beforeEach(() => {
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    indicatorsByTimeframe: {},
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
  });
  useChartPrefsStore.setState({
    indicatorModalByTimeframe: {},
    indicatorModalByWindow: {},
  });
});

describe('seedIndicatorScopeForWindow', () => {
  it('원본 창이 없으면 페이지 세트를 복사한다', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: { minute: { volumeEnabled: false } },
    });

    seedIndicatorScopeForWindow('w1', null);

    expect(useLivePageStore.getState().indicatorsByWindow[KEY])
      .toEqual({ minute: { volumeEnabled: false } });
  });

  it('원본 창이 있으면 **그 창**을 복사한다 — 페이지 세트가 아니다', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: { minute: { volumeEnabled: false } },
      indicatorsByWindow: { 'live:src': { minute: { ratioEnabled: true } } },
    });

    seedIndicatorScopeForWindow('w1', 'src');

    // 페이지 세트의 volumeEnabled:false 가 아니라 원본 창의 값이 와야 한다.
    expect(useLivePageStore.getState().indicatorsByWindow[KEY])
      .toEqual({ minute: { ratioEnabled: true } });
  });

  it('원본 창에 엔트리가 없으면 페이지 세트로 떨어진다', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: { minute: { volumeEnabled: false } },
    });

    seedIndicatorScopeForWindow('w1', 'ghost');

    expect(useLivePageStore.getState().indicatorsByWindow[KEY])
      .toEqual({ minute: { volumeEnabled: false } });
  });

  it('두 스토어에 함께 심는다 — 절반만 창별인 드로어가 되면 안 된다', () => {
    useChartPrefsStore.setState({
      indicatorModalByTimeframe: { minute: { surgeMarkerEnabled: false } },
    });

    seedIndicatorScopeForWindow('w1', null);

    expect(Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, KEY)).toBe(true);
    expect(useChartPrefsStore.getState().indicatorModalByWindow[KEY])
      .toEqual({ minute: { surgeMarkerEnabled: false } });
  });
});

describe('dropIndicatorScopes*', () => {
  it('두 스토어에서 함께 걷는다', () => {
    seedIndicatorScopeForWindow('w1', null);

    dropIndicatorScopesForWindows(['w1']);

    expect(Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, KEY)).toBe(false);
    expect(Object.hasOwn(useChartPrefsStore.getState().indicatorModalByWindow, KEY)).toBe(false);
  });

  it('사라진 id 만 걷는다 — 살아남은 창은 지킨다', () => {
    seedIndicatorScopeForWindow('w1', null);
    seedIndicatorScopeForWindow('w2', null);

    dropIndicatorScopesForRemovedWindows([{ id: 'w1' }, { id: 'w2' }], [{ id: 'w1' }]);

    const byWindow = useLivePageStore.getState().indicatorsByWindow;
    expect(Object.hasOwn(byWindow, 'live:w1')).toBe(true);
    expect(Object.hasOwn(byWindow, 'live:w2')).toBe(false);
  });
});
