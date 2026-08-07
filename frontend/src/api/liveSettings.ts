import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

// storage_policy·heatmap_capture_enabled는 제거됨(2026-07-17 정책: 호가·체결은
// KIS REST로 받지 않는다 — 관심종목=KIS WS, 히트맵=키움 WS).
// kiwoom_enabled(키움 활성화 스위치)는 폐지됨(ADR-0118) — 실시간=키움 WS 유일 소스라
// 선택지가 아니고, 활성화는 백엔드에서 자격증명(앱키) 존재만으로 게이트된다.
// program_trade_storage_enabled(프로그램 순매수 저장)도 폐지됨(2026-07-21) — 키움 0w
// push 전환으로 수집 비용이 0이 되어 거래원(0F)처럼 항시 저장한다.
export interface LiveSettings {
  schema_version: number;
  rest_bypass_enabled: boolean;
  screener_depth_autocollect: boolean;
  /** KRX 호가·체결을 hogaplay 우선으로 읽을지. 기본 false(키움 고정 사다리).
   *  경위는 `state/sourcePreference.ts` 와 `hoga/api/sources.py` 주석에. */
  krx_prefer_hogaplay: boolean;
}

export type LiveSettingsPatch = {
  rest_bypass_enabled?: boolean;
  screener_depth_autocollect?: boolean;
  krx_prefer_hogaplay?: boolean;
};

export const LIVE_SETTINGS_KEY = ['live', 'settings'] as const;

export function getLiveSettings(): Promise<LiveSettings> {
  return apiCall<LiveSettings>('/api/live/settings');
}

export function patchLiveSettings(patch: LiveSettingsPatch): Promise<LiveSettings> {
  return apiCall<LiveSettings>('/api/live/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function useLiveSettings() {
  return useQuery({
    queryKey: LIVE_SETTINGS_KEY,
    queryFn: getLiveSettings,
  });
}

export function usePatchLiveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchLiveSettings,
    // Optimistic shallow-merge so toggles flip instantly. onSuccess overwrites
    // with the authoritative server value, which corrects any server-derived
    // field the patch can't predict.
    // No cancelQueries: this settings query has no background refetch to race,
    // and cancelling it races the mount-time auto-PATCH in RestUnavailableToastHost.
    onMutate: (patch): { previous: LiveSettings | undefined } => {
      const previous = qc.getQueryData<LiveSettings>(LIVE_SETTINGS_KEY);
      if (previous) qc.setQueryData<LiveSettings>(LIVE_SETTINGS_KEY, { ...previous, ...patch });
      return { previous };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx) qc.setQueryData(LIVE_SETTINGS_KEY, ctx.previous);
    },
    onSuccess: (settings) => {
      qc.setQueryData(LIVE_SETTINGS_KEY, settings);
      void qc.invalidateQueries({ queryKey: ['live', 'status'] });
      pingLiveSettingsChanged();
    },
  });
}

/**
 * 탭 간 신호 키. **값이 아니라 핑이다** — 저장하는 문자열에 의미가 없고, 다른 탭에
 * "서버 설정이 바뀌었으니 다시 읽어라"만 알린다.
 *
 * 값을 미러링하지 않는 이유: 이 설정의 단일 진실은 서버다(`/api/live/settings`).
 * localStorage 에 값을 복제하면 진실이 둘이 되고, 서버가 patch 로 예측할 수 없는
 * 파생 필드를 돌려줄 때 복제본이 조용히 어긋난다. 핑만 보내면 각 탭이 서버에서
 * 다시 받으므로 **필드가 늘어도 이 코드는 그대로**다.
 */
const PING_KEY = 'live.settings.ping.v1';
let pingCounter = 0;

/**
 * ⚠ **같은 값을 다시 쓰면 `storage` 이벤트가 발생하지 않는다**(명세). 그래서 매번
 * 달라지는 문자열을 쓴다 — 타임스탬프만으로는 같은 ms 안의 연속 PATCH 가 묻히므로
 * 카운터를 붙인다. 이걸 놓치면 "동기되는 것처럼 생긴 죽은 코드"가 된다.
 */
function pingLiveSettingsChanged(): void {
  try {
    localStorage.setItem(PING_KEY, `${Date.now()}-${(pingCounter += 1)}`);
  } catch {
    // storage unavailable (SSR, privacy mode) — 이 탭의 동작에는 영향이 없다.
  }
}

/**
 * 다른 탭의 설정 변경을 이 탭에 알린다. 콜백은 보통
 * `invalidateQueries({ queryKey: LIVE_SETTINGS_KEY })` 다 — 값을 받는 게 아니라
 * 다시 읽는다.
 *
 * 이게 없으면 다른 탭은 **표시만 낡는 게 아니라 동작이 어긋난다**: QueryClient 가
 * `refetchOnWindowFocus: false` + `staleTime: 60s` + 폴링 없음이라(main.tsx) 쿼리를
 * 마운트한 채로 둔 탭은 영영 다시 읽지 않는데, 이 설정은 표시용이 아니라 데이터
 * 경로 분기다(useLiveBundle · useResolvedDailyCandles · sourcePreference · Screener).
 * 즉 서버는 새 정책, 그 탭은 옛 정책으로 요청을 짜는 상태가 된다.
 *
 * Returns an unsubscribe function (useEffect cleanup shape).
 */
export function subscribeToLiveSettingsPing(onChanged: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PING_KEY) return;
    onChanged();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
