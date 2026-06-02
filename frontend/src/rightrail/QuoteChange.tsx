/** 우측 패널 행의 등락 셀: 전일대비 등락액(원) + 등락률(%).
 *  KRX 색상 컨벤션(상승=빨강 --price-up / 하락=파랑 --price-down / 보합=중립).
 *  부호 있는 등락액(+750 / −750)이 색맹 보조 신호를 겸하므로 ▲▼ 글리프는 쓰지 않는다.
 *  - won·pct 둘 다 → "+750원 (1.20%)" (퍼센트는 부호 없이 괄호 안 절대값)
 *  - won 없음(스크리너 코퍼스 폴백) → 등락률만 "+1.20%"
 *  - 둘 다 null(장전/무데이터) → "—" */
import { priceDirClass } from '../ui/priceDir';

export function QuoteChange({ won, pct }: { won: number | null; pct: number | null }) {
  if (won === null && pct === null) return <span className="text-fg-dim">—</span>;
  const basis = won ?? pct ?? 0;
  const cls = priceDirClass(basis);

  if (won !== null) {
    const wonStr = `${won > 0 ? '+' : ''}${won.toLocaleString('ko-KR')}원`;
    const pctStr = pct !== null ? ` (${Math.abs(pct).toFixed(2)}%)` : '';
    return <span className={cls}>{wonStr}{pctStr}</span>;
  }
  // 폴백: 등락액 없이 등락률만 (live quote 가 안 붙은 스크리너 행)
  return <span className={cls}>{pct! > 0 ? '+' : ''}{pct!.toFixed(2)}%</span>;
}
