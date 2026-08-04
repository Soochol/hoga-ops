// ============================================================================
// PROTOTYPE — throwaway. 변형 A "정제된 3단": 현행 3단 구조를 유지하되
//  - 저장 목록 레일 접기(결과가 주인공이 될 수 있게)      … 제안 ⑦
//  - 결과 메타 줄(개수·기준·조회 시각·상태 칩)            … 제안 ②③
//  - 경고 배너는 최우선 1개만, 나머지는 칩으로 강등        … 제안 ⑧
//  - 등락률 사이클 정렬 버튼 제거(헤더 정렬만)            … 제안 ④
//  - 열 폭 rem 화(밀도 다이얼 추종)
// ============================================================================
import { useState } from 'react';
import { PageContainer } from '../../layout/PageContainer';
import { ConditionBuilder } from '../ConditionBuilder';
import { SavedScreenerList } from '../SavedScreenerList';
import { DataSection } from '../../ui/DataSurface';
import { ControlBar, PanelCard, SegmentedControl, ToolbarButton } from '../../ui/PageShell';
import { ResultsBody, ResultsMetaLine, TopFlagBanner, splitFlags } from './resultsBits';
import type { ScreenerViewProps } from './variantShared';

export function VariantA(p: ScreenerViewProps) {
  const [railCollapsed, setRailCollapsed] = useState(false);
  const { banner, chips } = splitFlags(p);
  return (
    <PageContainer className="grid gap-md min-h-0 !pb-0"
      style={{ gridTemplateColumns: railCollapsed ? '2.25rem 21rem minmax(0, 1fr)' : '14.75rem 21rem minmax(0, 1fr)' }}>
      <PanelCard borderless flat className="min-h-0 overflow-hidden">
        {railCollapsed ? (
          <div className="flex h-full flex-col items-center pt-md">
            <button type="button" aria-label="저장 목록 펼치기" title="저장한 조건검색 펼치기"
              onClick={() => setRailCollapsed(false)}
              className="w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">»</button>
            <span className="mt-2 text-2xs font-semibold uppercase text-fg-dim [writing-mode:vertical-rl]">
              저장한 조건검색
            </span>
          </div>
        ) : (
          <div className="relative h-full min-h-0">
            <button type="button" aria-label="저장 목록 접기" title="저장 목록 접기"
              onClick={() => setRailCollapsed(true)}
              className="absolute right-2 top-md z-10 w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">«</button>
            <SavedScreenerList anchorId={p.editor.anchorId} dirty={p.editor.dirty}
              onLoad={p.editor.load} onNewDraft={p.editor.newDraft}
              onSaveAsNew={p.editor.saveAsNew} onDuplicate={p.editor.duplicate}
              onRename={p.editor.rename} onRemove={p.editor.remove} />
          </div>
        )}
      </PanelCard>

      <PanelCard borderless flat className="min-h-0 overflow-hidden">
        <ConditionBuilder conditions={p.editor.conditions} universe={p.editor.universe}
          onConditionsChange={p.editor.editConditions} onUniverseChange={p.editor.editUniverse} />
      </PanelCard>

      <PanelCard borderless flat className="flex min-h-0 flex-col overflow-hidden">
        <div className="p-md">
          <ControlBar className="flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-fg truncate">{p.currentTitle}</span>
                {p.editor.dirty && <span className="text-2xs text-fg-dim">수정됨</span>}
              </div>
              {p.editor.saveError && (
                <div className="text-xs" style={{ color: 'var(--error)' }}>
                  저장 실패: {p.editor.saveError.message}
                </div>
              )}
            </div>
            <ToolbarButton onClick={p.saveCurrent} disabled={p.editor.isSaving} className="text-fg">
              {p.editor.isSaving ? '저장 중…' : '저장'}
            </ToolbarButton>
            <ToolbarButton onClick={p.openSaveAs} disabled={p.editor.isSaving}>
              다른 이름으로 저장
            </ToolbarButton>
            <div className="min-w-0 flex-1" />
            <SegmentedControl aria-label="스크리너 기준">
              {(['intraday', 'eod'] as const).map((value) => (
                <button key={value} type="button" onClick={() => p.setBasis(value)}
                  title={value === 'intraday' ? '조건검색 실행 시 오늘 KIS quote를 일봉 위에 임시 반영합니다' : undefined}
                  className={`px-3 py-[7px] text-sm ${p.basis === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
                  {value === 'intraday' ? '오늘 장중' : '전일 확정'}
                </button>
              ))}
            </SegmentedControl>
            <ToolbarButton tone="primary" onClick={p.runScan}
              disabled={p.scanPending || p.notSeeded || !p.hasConditions}
              className="px-lg py-sm text-base">
              {p.scanPending ? '조회 중…' : '조회'}
            </ToolbarButton>
            {!p.notSeeded && (
              <ToolbarButton aria-label="데이터 갱신" onClick={p.onUpdate}
                disabled={p.updatePending || p.serverUpdating}>
                {p.updatePending || p.serverUpdating ? '갱신 중…' : '갱신'}
              </ToolbarButton>
            )}
            {p.updateFailed && <span className="text-sm" style={{ color: 'var(--error)' }}>갱신 실패</span>}
            {p.updateFeedback && (
              <span className="text-sm text-fg-dim">{p.updateFeedback.message}</span>
            )}
          </ControlBar>
        </div>

        <DataSection title="결과" flushHeader className="flex min-h-0 flex-1 flex-col"
          contentClassName="flex min-h-0 flex-1 flex-col gap-sm p-md">
          <ResultsMetaLine p={p} chips={chips} />
          <TopFlagBanner banner={banner} />
          <ResultsBody p={p} />
        </DataSection>
      </PanelCard>
    </PageContainer>
  );
}
