import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 호가벽 급증 상세 설정.
 *
 *  마스터 토글은 패널 헤더가 들고(indicator 슬라이스), 여기서는 세부 옵션만 다룬다 —
 *  라벨 개수는 chartPrefs 라 다른 지표의 세부 옵션과 같은 자리에 있다.
 */
export default function WallSurgeConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        호가벽 급증 <span aria-hidden="true" className="text-fg-dim text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        한 호가 레벨에 물량이 순간적으로 몰린 지점을 캔들 차트의 그 가격 위치에 삼각형으로
        표시합니다. 매도벽은 아래를, 매수벽은 위를 가리킵니다. 잔량이 많은 것이 아니라
        <b> 짧은 시간에 갑자기 늘어난 것</b>을 잡습니다 — 큰 벽이 어디 있는지는 당일 최대벽이
        답합니다. 분봉 차트에서만 표시됩니다
      </p>
      <p className="text-fg-dim text-xs mb-3">
        채움이 그 벽의 결말입니다. <b>채운 삼각형</b>은 반대 세력이 체결로 먹었거나 가격이
        넘어선 경우, <b>외곽선만</b>은 체결 없이 취소된 경우(허수 의심), <b>반투명</b>은 아직
        버티는 벽(저항·지지선), <b>회색</b>은 아직 결말이 정해지지 않은 경우입니다
      </p>
      <p className="text-fg-dim text-xs mb-3">
        <b>점선 테두리</b>는 가격이 멀어져 호가창 밖에 있다가 돌아온 벽입니다. 얼마나 커졌는지는
        알지만 <b>언제 커졌는지는 알 수 없어</b> 시점이 부정확하다는 표시입니다
      </p>
      <div className="space-y-2">
        <IndicatorPrefRows toggleKeys={['wallSurgeLabelEnabled']} />
      </div>
    </div>
  );
}
