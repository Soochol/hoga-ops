export default function ProgramTradeConfig() {
  return (
    <div>
      <h3 className="text-fg text-sm font-medium mb-2">프로그램 순매수</h3>
      <p className="text-fg-dim text-sm leading-6">
        KIS REST 저장 데이터의 시간별 프로그램 누적 순매수 금액을 표시합니다.
      </p>
      <p className="text-fg-dimmer text-xs mt-2">
        0 위는 순매수, 0 아래는 순매도입니다.
      </p>
    </div>
  );
}
