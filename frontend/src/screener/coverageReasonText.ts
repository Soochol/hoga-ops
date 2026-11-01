const reasons: Record<string, string> = {
  share_evidence_unavailable: '주식 수 변환 이력 미확인', vendor_price_unavailable: '공급자 수정 가격 부족',
  zero_average_volume: '비교 평균 거래량이 0', invalid_volume_ratio: '거래량 비율 계산 불가',
  missing_history: '원본 일봉 부족', insufficient_history: '비교 기간 부족',
  original_observation_conflict: '원본과 공급자 관측값 충돌', invalid_daily_rows: '원본 일봉 오류',
  calendar_unavailable: '거래일 달력 부족', insufficient_minute_history: '비교할 분봉 부족',
  fetch_budget_exhausted: '이번 조회의 분봉 확인 범위 초과 · 재조회로 다음 종목 확인',
  fetch_timeout: '분봉 조회 시간 초과', credentials_missing: '시세 조회 연결 필요',
  rest_bypassed: '시세 조회 중지', historical_open_bar_unavailable: '저장된 순위 관측 당시의 진행 중 분봉을 복원할 수 없음',
  minute_date_mismatch: '순위 기준일의 분봉 없음',
};
export const coverageReasonText = (reason: string): string => reasons[reason] ?? '조회 자료 확인 필요';
