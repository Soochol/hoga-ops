import { useSearchParams } from 'react-router';

export function ScreenerBasisChip({ code }: { code: string | null }) {
  const [params] = useSearchParams();
  if (params.get('screener_code') !== code || !/^[a-f0-9]{64}$/.test(params.get('screener_snapshot') ?? '')) return null;
  return <span className="live-chart-state-chip text-xs text-fg-dim"
    data-tooltip={`스크리너 수정 가격 기준일 ${params.get('screener_asof') || '미확인'}. 차트는 현재 공급자 가격이며 조회 당시 버전 재현은 지원하지 않습니다.`}>
    현재 기준 차트
  </span>;
}
