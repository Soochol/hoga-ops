import { Fragment } from 'react';
import {
  useScopedChartPrefs,
  useChartPrefActions,
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  gatedByOf,
  type ChartToggleKey,
} from '../../state/chartPrefs';
import ToggleRow from './ToggleRow';
import NumericPrefRow from './NumericPrefRow';

/**
 * 주어진 토글 키 목록을 `ToggleRow` + (enabledBy로 묶인) 하위 `ToggleRow`·
 * `NumericPrefRow`로 렌더한다. 「설정」 모달(CategoryDetail)과 「지표」 모달의
 * 호가 Config가 동일한 행 디자인을 공유하도록 추출한 단일 소스. 키 순서가 아니라
 * CHART_TOGGLES 등록 순서를 따른다(기존 CategoryDetail 동작 유지).
 *
 * **하위 토글**: `enabledBy` 는 원래 numeric pref 에만 실효했다 — 레지스트리에
 * 적힌 boolean 부모-자식 관계는 렌더가 무시해서 화면엔 평평한 형제 행으로 나왔고,
 * 그 관계를 설명하는 것은 코드가 아니라 호출부 주석이었다(`QuoteTotalsConfig`).
 * 이제 둘이 같은 게이트 시맨틱을 쓴다: 들여쓰기 + 부모 OFF 시 dim, 값은 보존.
 *
 * 하위 행은 **부모 아래에서만** 그려지므로 호출부는 부모 키만 넘기면 된다. 부모·자식을
 * 함께 넘겨도(선례: `QuoteTotalsConfig`) 자식은 최상위 반복에서 빠져 중복되지 않는다.
 * 반대로 부모 없이 자식만 넘기면 최상위로 렌더한다 — 행이 조용히 사라지는 편보다 낫다.
 */
export default function IndicatorPrefRows({
  toggleKeys,
}: {
  toggleKeys: readonly ChartToggleKey[];
}) {
  // 읽기·쓰기 모두 이 서브트리의 창 봉 버킷을 향한다(Provider 밖=ambient 폴백).
  const prefs = useScopedChartPrefs();
  const { setToggle } = useChartPrefActions();
  const numericsGatedBy = (key: ChartToggleKey) => CHART_NUMERIC_PREFS.filter((p) => (
    'enabledBy' in p && p.enabledBy === key
  ));
  const keySet = new Set<string>(toggleKeys);
  const requested = CHART_TOGGLES.filter((t) => keySet.has(t.key));
  const toggles = requested.filter((t) => {
    const parent = gatedByOf(t);
    return parent === undefined || !keySet.has(parent);
  });
  return (
    <>
      {toggles.map((toggle, idx) => {
        const gatedToggles = CHART_TOGGLES.filter((t) => gatedByOf(t) === toggle.key);
        const gatedNumerics = numericsGatedBy(toggle.key);
        const gateOpen = prefs[toggle.key];
        return (
          <Fragment key={toggle.key}>
            <ToggleRow
              label={toggle.label}
              description={toggle.description}
              checked={prefs[toggle.key]}
              onToggle={() => setToggle(toggle.key, !prefs[toggle.key])}
              testId={`settings-toggle-${toggle.key}`}
            />
            {(gatedToggles.length > 0 || gatedNumerics.length > 0) && (
              <div className="ml-4">
                {gatedToggles.map((def) => (
                  <Fragment key={def.key}>
                    <ToggleRow
                      label={def.label}
                      description={def.description}
                      checked={prefs[def.key]}
                      onToggle={() => setToggle(def.key, !prefs[def.key])}
                      testId={`settings-toggle-${def.key}`}
                      disabled={!gateOpen}
                    />
                    {/* 하위 토글이 **자기 하위 numeric 을 갖는 경우**(`quoteTotalsTickNormalize`
                        → 확인 문턱). 이걸 빠뜨리면 토글을 부모 아래로 옮기는 순간 그 노브가
                        화면에서 조용히 사라진다 — 타입도 테스트도 안 잡는 종류의 소실이라
                        `TickNormalizeConfigRow.test.tsx` 가 그 자리를 지키고 있다. */}
                    {numericsGatedBy(def.key).map((n) => (
                      <div className="ml-4" key={n.key}>
                        <NumericPrefRow def={n} />
                      </div>
                    ))}
                  </Fragment>
                ))}
                {gatedNumerics.map((def) => (
                  <NumericPrefRow key={def.key} def={def} />
                ))}
              </div>
            )}
            {idx < toggles.length - 1 && <div className="my-1" />}
          </Fragment>
        );
      })}
    </>
  );
}
