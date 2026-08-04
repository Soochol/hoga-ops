// ============================================================================
// PROTOTYPE — throwaway. 변형 B "2단 워크벤치": 저장 목록 칼럼을 없애고
// 좌측 한 칼럼에 [저장본 셀렉터 + 저장 버튼 + 조건 빌더]를 세로로 묶는다.
// 결과 칼럼이 구조적으로 넓어진다(제안 ⑥⑦의 다른 답). 셀렉터는 프로토타입
// 등급의 네이티브 <select> — 이름변경/복제/삭제는 이 변형에서 생략(판단 대상은
// 배치이지 CRUD가 아니다).
// ============================================================================
import { PageContainer } from '../../layout/PageContainer';
import { ConditionBuilder } from '../ConditionBuilder';
import { DataSection } from '../../ui/DataSurface';
import { ControlBar, PanelCard, SegmentedControl, ToolbarButton } from '../../ui/PageShell';
import { ResultsBody, ResultsMetaLine, TopFlagBanner, splitFlags } from './resultsBits';
import type { ScreenerViewProps } from './variantShared';

export function VariantB(p: ScreenerViewProps) {
  const { banner, chips } = splitFlags(p);
  return (
    <PageContainer className="grid gap-md min-h-0 !pb-0"
      style={{ gridTemplateColumns: '23rem minmax(0, 1fr)' }}>
      <PanelCard borderless flat className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex flex-col gap-sm p-md pb-0">
          <span className="text-2xs font-semibold uppercase text-fg-dim">조건검색</span>
          <div className="flex items-center gap-sm">
            <select
              aria-label="저장한 조건검색 선택"
              value={p.editor.anchorId ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) { p.editor.newDraft(); return; }
                const s = p.saves.find((x) => x.id === id);
                if (s) p.editor.load(s);
              }}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-input px-2 py-1.5 text-sm text-fg"
            >
              <option value="">새 조건검색</option>
              {p.saves.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {p.editor.dirty && <span className="shrink-0 text-2xs text-fg-dim">수정됨</span>}
          </div>
          <div className="flex items-center gap-1">
            <ToolbarButton onClick={p.saveCurrent} disabled={p.editor.isSaving} className="text-fg">
              {p.editor.isSaving ? '저장 중…' : '저장'}
            </ToolbarButton>
            <ToolbarButton onClick={p.openSaveAs} disabled={p.editor.isSaving}>
              다른 이름으로 저장
            </ToolbarButton>
          </div>
          {p.editor.saveError && (
            <div className="text-xs" style={{ color: 'var(--error)' }}>
              저장 실패: {p.editor.saveError.message}
            </div>
          )}
          <div className="border-t border-border" />
        </div>
        <div className="min-h-0 flex-1">
          <ConditionBuilder conditions={p.editor.conditions} universe={p.editor.universe}
            onConditionsChange={p.editor.editConditions} onUniverseChange={p.editor.editUniverse} />
        </div>
      </PanelCard>

      <PanelCard borderless flat className="flex min-h-0 flex-col overflow-hidden">
        <div className="p-md">
          <ControlBar className="flex-wrap">
            <span className="font-semibold text-fg truncate">{p.currentTitle}</span>
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
