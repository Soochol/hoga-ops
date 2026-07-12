interface Props {
  /** hogaplay 공백을 KIS 분봉으로 복구한 거래일(YYYYMMDD) 목록. */
  dates: readonly string[] | undefined;
}

/**
 * KIS 보충 캔들 배지 — /study 저장뷰에서 hogaplay 캡처가 빈 거래일을 KIS 과거
 * 분봉으로 복구(kis_api candles.parquet)한 날이 있을 때 표시한다.
 *
 * data provenance 범주(DESIGN.md Source identity chips)라 kis_api 토큰(warn-tint)을
 * 쓴다 — warn 톤이 "이 날 캔들은 보충본이며 호가 기반 지표(최대벽·POC·거래량분포·
 * 호가비)는 없다"는 주의를 함께 전한다. 복구일이 없으면 렌더하지 않는다.
 */
export function StudyRepairedBadge({ dates }: Props) {
  if (!dates || dates.length === 0) return null;
  return (
    <span
      data-testid="study-repaired-candle-badge"
      title={`KIS 분봉으로 보충한 거래일: ${dates.join(', ')} — 이 날 캔들은 KIS 보충본이며 호가 기반 지표(최대벽·POC·거래량분포·호가비)는 없습니다.`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 var(--space-sm)',
        height: '1.2rem',
        background: 'var(--source-kis-api-bg)',
        border: '1px solid var(--source-kis-api-border)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg-dim)',
        whiteSpace: 'nowrap',
      }}
    >
      KIS 보충 캔들 {dates.length}일 · 호가 지표 없음
    </span>
  );
}
