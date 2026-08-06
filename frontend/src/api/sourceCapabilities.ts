import type { SourceName } from './types';

// SOURCE_CAPABILITIES 의 kis_api 항목은 유지 — 소스 유니온의 전수 표기를 여기서 소유한다.

export interface SourceCapability {
  source: SourceName;
  label: string;
}

// 소스별 표기 레지스트리. 2026-07-31 기준 유일한 소비자는 SOURCE_PREFERENCE_LABELS다 —
// 소스별 렌더 필드(resolutionLabel·cssTokenName)는 SourceChip과 함께 제거했다.
export const SOURCE_CAPABILITIES: Record<SourceName, SourceCapability> = {
  hogaplay: {
    source: 'hogaplay',
    label: 'hogaplay',
  },
  kis_api: {
    source: 'kis_api',
    label: 'KIS API',
  },
  kiwoom_live: {
    source: 'kiwoom_live',
    label: '키움 WS',
  },
  screener_daily: {
    source: 'screener_daily',
    label: '스크리너',
  },
};

// 소스 선호 옵션 정의(`SOURCE_PREFERENCE_OPTIONS` · 라벨 · 대표 소스 맵)는 폐지됐다
// (2026-08-07). 셋 중 둘이 venue 비교를 깨뜨려 사다리를 키움 고정으로 두고 선택지를
// 없앴다 — `state/sourcePreference.ts` 와 `hoga/api/sources.py::ORDERFLOW_LADDER` 참조.
//
// `SOURCE_CAPABILITIES`(위)는 남는다: 소스별 **표기 라벨**은 차트의 소스 배지가 쓴다.
// 무엇을 고를지는 사라졌어도 무엇을 보고 있는지는 여전히 보여 줘야 한다.
