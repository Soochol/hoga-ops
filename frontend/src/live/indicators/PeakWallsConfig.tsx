import { useState } from 'react';
import type { PeakWallFamilyId } from '../../state/peakWallFamilyPrefs';
import { SettingsRow, ToggleSwitch } from '../settings/SettingsRow';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import PeakWallMatrix from './PeakWallMatrix';
import PeakWallRelationSchema from './PeakWallRelationSchema';
import PeakWallDetailZone from './PeakWallDetailZone';

type Side = 'ask' | 'bid';

/**
 * 당일 최대벽 설정 — **방향 × 계열 매트릭스** + 고른 칸의 세부.
 *
 * ## 위치가 스코프를 말한다 (한 문법으로)
 *
 * 2026-08-25 재구성이 세운 규칙("카드 안이면 그 계열, 밖이면 공통")은 옳았지만,
 * 매도|매수 **탭** 때문에 관례가 하나로 안 모였다 — 방향 공용 항목은 "탭 밖" 이라는
 * 두 번째 관례를 따로 만들어야 했고, 그 관례는 화면에서 읽히지 않았다(탭 경계는
 * 눈에 보이는 선이 아니다). 열·행·푸터·매트릭스 밖 네 자리가 그 관례들을 흡수한다:
 *
 * - 열 머리 = 방향 마스터 · 셀 = 방향 × 계열 · 푸터 행 = 방향별 계열 공용
 * - **매트릭스 밖 = 방향까지 공용** — 강도 pane 이 여기다. 한 pane 에 양방향 계단이
 *   함께 살아 상태가 하나뿐이라, 매도에서 켜면 매수도 켜진다. 그 사실을 배지와
 *   위치로 함께 말한다.
 *
 * 탭이 사라지면서 **절반의 상태를 항상 숨기던 것**도 끝났다. 두 방향이 완전한
 * 미러라 나란히 두면 대칭이 그대로 보인다.
 *
 * 제목·설명은 이 컴포넌트가 갖지 않는다 — 카테고리 표가 패널 헤더에서 말한다.
 */
export default function PeakWallsConfig() {
  // 어느 칸의 세부를 보고 있는가. **저장되는 설정이 아니라 표현 상태**라 창을
  // 다시 열면 매도·체결된 벽으로 돌아온다(패널이 `key={windowId}` 로 재마운트).
  const [cell, setCell] = useState<{ side: Side; family: PeakWallFamilyId }>({
    side: 'ask',
    family: 'Traded',
  });

  const paneEnabled = useWindowIndicator((s) => s.peakWallPaneEnabled);
  const setPaneEnabled = useIndicatorActions().setPeakWallPaneEnabled;

  const tradedColor = useWindowIndicator((s) => (cell.side === 'ask' ? s.askPeakColor : s.bidPeakColor));
  const unreachedColor = useWindowIndicator((s) => (cell.side === 'ask' ? s.askPeakUnreachedColor : s.bidPeakUnreachedColor));
  const allWallColor = useWindowIndicator((s) => (cell.side === 'ask' ? s.askPeakAllWallColor : s.bidPeakAllWallColor));

  return (
    <div>
      <PeakWallRelationSchema
        side={cell.side}
        tradedColor={tradedColor}
        unreachedColor={unreachedColor}
        allWallColor={allWallColor}
      />

      <div className="mt-4">
        <PeakWallMatrix selected={cell} onSelect={setCell} />
      </div>

      {/* 방향까지 공용 — 매트릭스 **밖**이다. 한 pane 을 양방향이 공유하므로 열
          아래에 둘 수가 없다(어느 열에 두든 거짓말이 된다). */}
      <div className="mt-3 rounded-lg bg-bg-subtle px-3 py-1">
        {/* `ToggleRow` 대신 직접 조립하는 이유: 저쪽은 라벨 하나를 표시 텍스트와
            스위치 aria-label 로 겸해 쓰므로 문자열이어야 한다. 여기는 배지가 붙은
            노드라, 보이는 라벨과 읽히는 이름을 갈라 준다. */}
        <SettingsRow
          testId="peak-wall-pane-row"
          label={(
            <span className="flex items-center gap-2">
              최대벽 강도 pane
              <span className="rounded-full border border-border-strong px-1.5 py-px text-2xs font-semibold uppercase text-fg-dim">
                매도 · 매수 공용
              </span>
            </span>
          )}
          description="위에서 켠 계열의 계단을 차트 아래 별도 pane 에 그립니다. 한 pane 을 양방향이 공유합니다. 미도달 벽은 고가가 벽을 넘으면 계단이 내려갑니다."
        >
          <ToggleSwitch
            label="최대벽 강도 pane"
            checked={paneEnabled}
            onClick={() => setPaneEnabled(!paneEnabled)}
            data-testid="settings-toggle-peakWallPaneEnabled"
          />
        </SettingsRow>
      </div>

      <PeakWallDetailZone side={cell.side} family={cell.family} />
    </div>
  );
}
