import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LIVE_SETTINGS_KEY, subscribeToLiveSettingsPing } from '../api/liveSettings';
import { subscribeToLiveVenueStorage } from './liveVenue';
import { subscribeToThemePreferenceStorage } from './themePrefs';

/**
 * 탭 전역 설정의 **단 하나의 구독 지점**.
 *
 * 여기 모이는 것의 공통점은 저장 위치가 아니라 **범위**다 — 사용자가 "앱 설정"으로
 * 이해하는 값들이라, 한 탭에서 바꾸면 열려 있는 다른 탭도 리로드 없이 따라와야
 * 한다. `/live` 딥링크가 새 탭을 여는 구조라(live/liveNavigate.ts) 낡은 탭은 예외가
 * 아니라 평상 상태다.
 *
 * 반대로 **탭별로 남아야 하는 것은 여기 넣지 않는다**: 워크스페이스 창 배치처럼
 * "이 탭에서 지금 무엇을 보는가"에 해당하는 뷰 상태는 sessionStorage 스코프다
 * (state/persist.ts 의 `tab`). 여기에 넣으면 탭을 나눠 쓰는 사용법이 죽는다.
 *
 * 동기 방식이 값마다 다른 것은 **진실이 어디 있는가**를 따른 결과다:
 *   - 테마 선호 · 거래소 → 진실이 localStorage → 저장소를 **다시 읽는다**.
 *   - LiveSettings(REST 우회 · hogaplay 우선 …) → 진실이 **서버** → 값을 복제하지
 *     않고 "다시 읽어라"는 핑만 받아 쿼리를 invalidate 한다. 그래서 서버에 필드가
 *     늘어도 이 파일은 그대로다.
 *
 * App(레이아웃 라우트)이 유일한 호출자다 — 전 라우트를 감싸므로 여기 한 번이면
 * 모든 탭·모든 페이지가 덮인다.
 */
export function useCrossTabSync(): void {
  const qc = useQueryClient();

  useEffect(() => subscribeToThemePreferenceStorage(), []);
  useEffect(() => subscribeToLiveVenueStorage(), []);
  useEffect(
    () =>
      subscribeToLiveSettingsPing(() => {
        void qc.invalidateQueries({ queryKey: LIVE_SETTINGS_KEY });
      }),
    [qc],
  );
}
