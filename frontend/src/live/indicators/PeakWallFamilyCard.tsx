import { useState, type ReactNode } from 'react';
import MAStylePicker from './MAStylePicker';

const RANK_OPTIONS = [1, 2, 3] as const;

/** 계열 카드의 「표시 개수」 세그먼트 — 세 카드가 **같은 한 벌**을 쓴다.
 *  종전엔 체결된 벽 카드에만 있어 호출부에 인라인이었는데, 셋으로 늘면서 복제가
 *  세 벌이 될 자리였다. 라벨에 계열명을 넣어 aria 로도 어느 카드인지 읽힌다. */
export function PeakWallRankSelect({
  familyName,
  value,
  onChange,
}: {
  familyName: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const label = `${familyName} 표시 개수`;
  return (
    <>
      표시 개수
      <span
        className="inline-flex overflow-hidden rounded-md border border-border"
        role="group"
        aria-label={label}
      >
        {RANK_OPTIONS.map((option) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option)}
              className={[
                'px-2.5 py-0.5 text-xs border-r border-border last:border-r-0 transition-colors',
                selected ? 'bg-accent text-accent-fg' : 'bg-bg-elevated text-fg-dim hover:text-fg',
              ].join(' ')}
            >
              {option}
            </button>
          );
        })}
      </span>
    </>
  );
}

/**
 * 「어떤 벽」 구획의 계열 카드 하나 — 토글 + 선 스타일 + (있으면) 그 계열 전용 노브.
 *
 * ## 왜 카드인가
 *
 * 종전엔 세 계열이 평평한 형제 행이었고, **그 계열에만 해당하는 노브가 멀리 떨어져
 * 있었다** — 「체결된 벽 표시 개수」가 패널 맨 아래에 있어 어느 선 얘긴지 물어야 했다.
 * 카드는 "이 계열의 것" 을 위치로 말한다: 안에 있으면 그 계열, 밖에 있으면 공통.
 *
 * ## 상태를 갖지 않는다 (⚠ 의도)
 *
 * 값·setter 를 전부 props 로 받는다. 예외는 `details` 의 열림 여부 하나뿐인데, 그건 저장되는
 * 설정이 아니라 이 카드의 표현 상태다 — 그래서 **끈 항목 개수(`detailsOffCount`)조차 여기서
 * 세지 않고 숫자로 받는다**. 세려면 pref 를 읽어야 하고, 그 순간 이 파일이 저장소를 알게 된다. 병행 세션이 지표를 **인스턴스 모델**(레전드 칩 =
 * 인스턴스, 슬롯 배열)로 옮기는 중이고, 최대벽 계열은 언젠가 그 모델에 흡수될 후보다.
 * 지금 여기에 자체 상태 모양(`PeakWallFamilyConfig` 같은 타입)을 만들면 **세 번째
 * 패턴**이 생겨 그 흡수가 더 비싸진다. 이 파일은 표현 계층에만 머문다.
 */
export default function PeakWallFamilyCard({
  name,
  description,
  color,
  lineWidth,
  onStyleChange,
  enabled,
  onToggle,
  testId,
  extra,
  details,
  detailsOffCount,
}: {
  name: string;
  /** 한 줄 설명 — 세 카드가 나란히 있을 때 **셋의 관계**를 그 자리에서 알려 준다. */
  description: string;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  onStyleChange: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  enabled: boolean;
  onToggle: () => void;
  testId: string;
  /** 이 계열에만 있는 노브(예: 체결된 벽의 표시 개수). 없으면 구분선도 안 그린다. */
  extra?: ReactNode;
  /** 접히는 「세부 설정」 — 이 계열의 표면(라벨·레전드 셀·화살표)과 후보 기준(MA 둘).
   *  기본 접힘: 계열이 셋이라 전부 펼치면 21행이 되어 「어떤 벽」 구획이 화면 밖으로 밀린다. */
  details?: ReactNode;
  /** 그 계열에서 **꺼 둔** 세부 항목 개수. 전부 기본값(켜짐)이면 0 이고 뱃지도 안 뜬다.
   *  접힌 채로도 "여기 뭔가 꺼져 있다" 가 보여야 한다 — 안 보이면 라벨이 안 뜨는 이유를
   *  다시 찾게 된다. */
  detailsOffCount?: number;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div className="mt-1.5 rounded-lg border border-border bg-bg-subtle px-2.5 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm text-fg">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            {name}
          </div>
          <div className="mt-0.5 text-xs text-fg-dim">{description}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MAStylePicker
            color={color}
            lineWidth={lineWidth}
            onChange={onStyleChange}
            label={name}
          />
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={name}
            data-testid={testId}
            onClick={onToggle}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
              enabled ? 'border-accent bg-accent' : 'border-border bg-bg-input-hover'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
                enabled ? 'bg-accent-fg translate-x-[18px]' : 'bg-fg-dim translate-x-[2px]'
              }`}
            />
          </button>
        </div>
      </div>
      {(extra !== undefined || details !== undefined) && (
        <div className="mt-2 flex items-center gap-2 border-t border-dashed border-border pt-2 text-xs text-fg-dim">
          {extra}
          {details !== undefined && (
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((prev) => !prev)}
              data-testid={`${testId}-details`}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-xs text-fg-dim transition-colors hover:text-fg"
            >
              세부 설정
              {detailsOffCount !== undefined && detailsOffCount > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-fg">
                  {detailsOffCount}
                </span>
              )}
              <span aria-hidden="true">{detailsOpen ? '▴' : '▾'}</span>
            </button>
          )}
        </div>
      )}
      {details !== undefined && detailsOpen && (
        <div className="mt-1">{details}</div>
      )}
    </div>
  );
}

/** 구획 머리 — 「어떤 벽」·「어디에」·「후보 기준」. 라벨 뒤로 선이 이어져 구획의
 *  범위를 눈으로 닫는다(설정 모달의 다른 소제목보다 한 단계 약한 위계). */
export function PeakWallSectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3.5 mb-0.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-dimmer">
      {children}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}
