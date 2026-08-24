import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore } from './livePage';
import { useChartPrefsStore } from './chartPrefs';
import {
  captureIndicatorPayloadForWindow,
  dropIndicatorScopesForRemovedWindows,
  dropIndicatorScopesForWindows,
  restoreIndicatorScopesFromPayload,
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

/**
 * 프리셋 payload 의 지표 캡처·복원 (ADR-0159).
 *
 * **막는 방향**: ① 프리셋을 갈아탄 뒤 지표가 페이지 세트로 리셋되는 것, ② 스토어에
 * 없는 창 id 로 지표가 심겨 **회수 불가능한 고아**가 되는 것, ③ 두 스토어 중 한쪽만
 * 복원되어 드로어가 절반만 프리셋 값이 되는 것.
 *
 * **못 보는 것**: 실제 화면 반영. 여기서 재는 것은 스토어 상태뿐이고, 창이 자기
 * 세트를 읽는지는 `windowView.scope.test.tsx` 가 잰다.
 *
 * **등록 의존**: `applyPresetPayload` 가 이 함수를 **스냅샷 적용 뒤에** 부르는지는
 * `layoutPresetSnapshot.test.ts` 가 잰다 — 순서가 계약이라 그쪽이 본체다.
 */
describe('프리셋 payload 지표 (ADR-0159)', () => {
  describe('captureIndicatorPayloadForWindow', () => {
    it('두 스토어의 창 세트를 함께 담는다', () => {
      useLivePageStore.setState({
        indicatorsByWindow: { [KEY]: { minute: { volumeEnabled: false } } },
      });
      useChartPrefsStore.setState({
        indicatorModalByWindow: { [KEY]: { minute: { surgeMarkerEnabled: false } } },
      });

      expect(captureIndicatorPayloadForWindow('w1')).toEqual({
        indicators: { minute: { volumeEnabled: false } },
        indicatorModal: { minute: { surgeMarkerEnabled: false } },
      });
    });

    it('엔트리가 없어도 `{}` 를 담는다 — 생략하면 적용 시 페이지 세트가 새어든다', () => {
      // 공장값 상태의 창은 복사할 diff 가 없어 `{}` 가 정상값이다(ADR-0152 멤버십).
      useLivePageStore.setState({ indicatorsByTimeframe: { minute: { volumeEnabled: false } } });

      expect(captureIndicatorPayloadForWindow('w1'))
        .toEqual({ indicators: {}, indicatorModal: {} });
    });

    it('깊은 사본이다 — payload 를 변형해도 스토어가 안 바뀐다', () => {
      useLivePageStore.setState({
        indicatorsByWindow: { [KEY]: { minute: { volumeEnabled: false } } },
      });

      const payload = captureIndicatorPayloadForWindow('w1');
      payload.indicators!.minute!.volumeEnabled = true;

      expect(useLivePageStore.getState().indicatorsByWindow[KEY])
        .toEqual({ minute: { volumeEnabled: false } });
    });
  });

  describe('restoreIndicatorScopesFromPayload', () => {
    const win = (id: string, kind = 'chart') => ({ id, kind });

    it('두 스토어에 함께 심는다', () => {
      restoreIndicatorScopesFromPayload(
        [win('w1')],
        [{
          id: 'w1',
          indicators: { minute: { volumeEnabled: false } },
          indicatorModal: { minute: { surgeMarkerEnabled: false } },
        }],
      );

      expect(useLivePageStore.getState().indicatorsByWindow[KEY])
        .toEqual({ minute: { volumeEnabled: false } });
      expect(useChartPrefsStore.getState().indicatorModalByWindow[KEY])
        .toEqual({ minute: { surgeMarkerEnabled: false } });
    });

    it('**이미 있는 엔트리를 덮어쓴다** — 시드와 다른 점이자 이 기능의 인수 조건', () => {
      useLivePageStore.setState({
        indicatorsByWindow: { [KEY]: { minute: { volumeEnabled: true } } },
      });

      restoreIndicatorScopesFromPayload(
        [win('w1')],
        [{ id: 'w1', indicators: { minute: { volumeEnabled: false } }, indicatorModal: {} }],
      );

      expect(useLivePageStore.getState().indicatorsByWindow[KEY])
        .toEqual({ minute: { volumeEnabled: false } });
    });

    it('**스토어에 없는 창은 건너뛴다** — 회수 불가능한 고아를 만들지 않는다', () => {
      // readWindow 가 거부한 창(손상된 rect)·공장 폴백이 이 모양이다. payload 를
      // 순회해 심으면 그 키는 어떤 창도 가진 적이 없어 GC 가 영영 닿지 못한다.
      restoreIndicatorScopesFromPayload(
        [],
        [{ id: 'w1', indicators: { minute: { volumeEnabled: false } }, indicatorModal: {} }],
      );

      expect(useLivePageStore.getState().indicatorsByWindow).toEqual({});
      expect(useChartPrefsStore.getState().indicatorModalByWindow).toEqual({});
    });

    it('차트가 아닌 창은 건너뛴다 — 지표를 갖는 창은 차트뿐이다', () => {
      restoreIndicatorScopesFromPayload(
        [win('w1', 'book')],
        [{ id: 'w1', indicators: { minute: { volumeEnabled: false } }, indicatorModal: {} }],
      );

      expect(useLivePageStore.getState().indicatorsByWindow).toEqual({});
    });

    it('지표 키가 둘 다 없는 창은 건너뛴다 — 이 기능 이전에 저장된 프리셋(하위호환)', () => {
      restoreIndicatorScopesFromPayload([win('w1')], [{ id: 'w1' }]);

      expect(Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, KEY)).toBe(false);
    });

    it('한쪽 키만 있으면 없는 쪽을 `{}` 로 채운다 — 멤버십이 갈리면 안 된다', () => {
      restoreIndicatorScopesFromPayload(
        [win('w1')],
        [{ id: 'w1', indicators: { minute: { volumeEnabled: false } } }],
      );

      expect(Object.hasOwn(useChartPrefsStore.getState().indicatorModalByWindow, KEY)).toBe(true);
      expect(useChartPrefsStore.getState().indicatorModalByWindow[KEY]).toEqual({});
    });

    it('손상된 payload 값을 소독한다 — 서버에서 오는 신뢰 불가 데이터다', () => {
      restoreIndicatorScopesFromPayload(
        [win('w1')],
        [{
          id: 'w1',
          indicators: { minute: { volumeEnabled: 'yes', 없는키: 1 }, 없는봉: { x: 1 } },
          indicatorModal: 'not-an-object',
        }],
      );

      // 모르는 키·틀린 타입은 걷히고, 엔트리 자체는 살아남는다(멤버십).
      expect(useLivePageStore.getState().indicatorsByWindow[KEY]).toEqual({});
      expect(useChartPrefsStore.getState().indicatorModalByWindow[KEY]).toEqual({});
    });

    it('빈 payload 창 목록에서는 아무것도 하지 않는다', () => {
      useLivePageStore.setState({
        indicatorsByWindow: { [KEY]: { minute: { volumeEnabled: false } } },
      });

      restoreIndicatorScopesFromPayload([win('w1')], []);

      expect(useLivePageStore.getState().indicatorsByWindow[KEY])
        .toEqual({ minute: { volumeEnabled: false } });
    });
  });
});
