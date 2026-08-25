import type { ReactNode } from 'react';
import MAStylePicker from './MAStylePicker';

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
 * 값·setter 를 전부 props 로 받는다. 병행 세션이 지표를 **인스턴스 모델**(레전드 칩 =
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
}) {
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
      {extra !== undefined && (
        <div className="mt-2 flex items-center gap-2 border-t border-dashed border-border pt-2 text-xs text-fg-dim">
          {extra}
        </div>
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
