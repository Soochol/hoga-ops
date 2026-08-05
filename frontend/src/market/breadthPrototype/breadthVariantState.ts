// PROTOTYPE — throwaway. 변형 키·훅 (fast-refresh 규칙 때문에 컴포넌트와 분리).
import { useSearchParams } from 'react-router';

export const BREADTH_VARIANTS = ['current', 'a', 'b', 'c', 'd', 'e', 'f'] as const;
export type BreadthVariant = (typeof BREADTH_VARIANTS)[number];

export const LABELS: Record<BreadthVariant, string> = {
  current: '현행 — 극단값 4타일',
  a: 'A — 폭 우선 (상승비율 + 상·하한)',
  b: 'B — 터미널 행 (한 줄 전수)',
  c: 'C — A + 누적 등락선',
  d: 'D — 분산도 (지수장/종목장)',
  e: 'E — 쏠림·열기',
  f: 'F — 정규화 게이지',
};

/** 각 변형이 "무엇을 말하는가" — 스위처가 화면에 그대로 띄운다(상태 노출). */
export const MECHANISM: Record<BreadthVariant, string> = {
  current:
    '52주 신고/신저 · 급등/급락. 급등·급락은 ka10019(순간 급변 스캔)라 마감 후 거의 0 — 실측 코스피 1 / 코스닥 0 (같은 날 코스닥 상한가 11)',
  a: '상승비율 큰 숫자 + 등락 막대 + 상한/하한 + 52주 신고/신저. 급등·급락 제거. **추가 콜 0** (ka20003 이 이미 주는 값)',
  b: '시장당 한 행에 전수 나열 — 상승/하락/보합·비율·상한/하한·52주·상승업종수. 밀도 최대, 위계 없음',
  c: 'A + 누적 등락선(AD Line). **선은 목업이다** — 실제로는 하루 한 점씩 쌓아야 하고 수십 거래일이 필요하다',
  d: '업종 등락률의 퍼짐 — 스프레드·표준편차·분포 띠. 개수 축이 구조적으로 말 못 하는 "오늘 지수장인가 종목장인가". 실데이터',
  e: '규모별 거래대금 비중(코스피 대형주 83%) · 거래대금 · 참여율. **실측 픽스처** — 백엔드 `trade_value_eok`/`listed_count` 가 사용자 서버에 아직 없다',
  f: '0~100 정규화 3종(High-Low Index · 상승비율 · ADR) + 시장 간 상대강도. 개수와 달리 **어제와 비교된다**. 실데이터',
};

export function useBreadthVariant(): BreadthVariant {
  const [params] = useSearchParams();
  const raw = params.get('breadth') ?? 'current';
  return (BREADTH_VARIANTS as readonly string[]).includes(raw) ? (raw as BreadthVariant) : 'current';
}
