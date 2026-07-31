import { vi } from 'vitest';
vi.mock('./FolderAddButton', () => ({ FolderAddButton: () => null }));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { HeatmapFolder } from './HeatmapFolder';
import type { HeatmapEntry, HeatmapFolder as HeatmapFolderModel } from '../api/heatmap';
import type { LiveQuote } from '../api/liveQuotes';

const folder: HeatmapFolderModel = { id: 'f1', name: '반도체', order: 0 };
const entries: HeatmapEntry[] = [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }];
const quotes = new Map<string, LiveQuote>();

function renderFolder(props: Partial<React.ComponentProps<typeof HeatmapFolder>> = {}) {
  return render(<HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
    sortMode="manual" onPick={() => {}} {...props} />);
}

const nameEl = () => screen.getByTestId('heatmap-folder-name-f1');
const input = () => screen.getByLabelText('그룹 이름 수정') as HTMLInputElement;

// 시그니처를 명시한다 — ReturnType<typeof vi.fn> 은 Procedure|Constructable 로 넓어져
// 컴포넌트 prop 타입에 붙지 않는다(테스트가 실제 계약을 검증한다는 보장도 사라진다).
type RenameFn = (folderId: string, name: string) => Promise<void>;
let onRenameFolder: ReturnType<typeof vi.fn<RenameFn>>;
beforeEach(() => { onRenameFolder = vi.fn<RenameFn>(() => Promise.resolve()); });

describe('그룹명 더블클릭 인라인 편집', () => {
  it('더블클릭 → 입력 등장, Enter 로 커밋', async () => {
    renderFolder({ onRenameFolder });
    fireEvent.doubleClick(nameEl());
    fireEvent.change(input(), { target: { value: '반도체-메모리' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(onRenameFolder).toHaveBeenCalledWith('f1', '반도체-메모리'));
  });

  it('Escape 는 커밋하지 않고 원래 이름으로 되돌린다', async () => {
    renderFolder({ onRenameFolder });
    fireEvent.doubleClick(nameEl());
    fireEvent.change(input(), { target: { value: '버려질 이름' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('heatmap-folder-name-f1')).toHaveTextContent('반도체'));
    expect(onRenameFolder).not.toHaveBeenCalled();
  });

  it('blur 도 커밋한다(다른 곳을 클릭해도 편집이 유실되지 않게)', async () => {
    renderFolder({ onRenameFolder });
    fireEvent.doubleClick(nameEl());
    fireEvent.change(input(), { target: { value: '새 이름' } });
    fireEvent.blur(input());
    await waitFor(() => expect(onRenameFolder).toHaveBeenCalledWith('f1', '새 이름'));
  });

  it('빈 이름·무변경은 커밋하지 않는다(서버 왕복 낭비 + 빈 이름은 422)', async () => {
    renderFolder({ onRenameFolder });
    fireEvent.doubleClick(nameEl());
    fireEvent.change(input(), { target: { value: '   ' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('heatmap-folder-name-f1')).toBeInTheDocument());
    fireEvent.doubleClick(nameEl());
    fireEvent.keyDown(input(), { key: 'Enter' });   // 값 그대로 = 무변경
    await waitFor(() => expect(screen.getByTestId('heatmap-folder-name-f1')).toBeInTheDocument());
    expect(onRenameFolder).not.toHaveBeenCalled();
  });

  it('실패하면 입력을 닫지 않고 사유를 보여 재시도시킨다', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('이미 있는 이름입니다')));
    renderFolder({ onRenameFolder: failing });
    fireEvent.doubleClick(nameEl());
    fireEvent.change(input(), { target: { value: '중복' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByText('이미 있는 이름입니다')).toBeInTheDocument();
    expect(screen.getByLabelText('그룹 이름 수정')).toBeInTheDocument();  // 열린 채 유지
  });

  it('onRenameFolder 미전달이면 더블클릭이 아무 일도 하지 않는다', () => {
    renderFolder();
    fireEvent.doubleClick(nameEl());
    expect(screen.queryByLabelText('그룹 이름 수정')).toBeNull();
  });
});

describe('그룹 헤더 우클릭 메뉴', () => {
  const header = () => screen.getByText('반도체').closest('.min-h-list-group-header') as HTMLElement;

  it('우클릭 → 이름 변경 / 그룹 삭제', async () => {
    const onDeleteFolder = vi.fn();
    renderFolder({ onRenameFolder, onDeleteFolder });
    fireEvent.contextMenu(header());
    expect(await screen.findByTestId('heatmap-group-menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((b) => b.getAttribute('data-testid')))
      .toEqual(['heatmap-group-menu-rename', 'heatmap-group-menu-delete']);
  });

  it("메뉴의 '이름 변경'도 같은 인라인 입력을 연다(더블클릭과 같은 도착지)", async () => {
    renderFolder({ onRenameFolder });
    fireEvent.contextMenu(header());
    fireEvent.click(await screen.findByTestId('heatmap-group-menu-rename'));
    expect(screen.getByLabelText('그룹 이름 수정')).toBeInTheDocument();
  });

  it('삭제는 folderId·name 을 그대로 넘긴다(confirm 은 호출측 책임)', async () => {
    const onDeleteFolder = vi.fn();
    renderFolder({ onDeleteFolder });
    fireEvent.contextMenu(header());
    fireEvent.click(await screen.findByTestId('heatmap-group-menu-delete'));
    expect(onDeleteFolder).toHaveBeenCalledWith('f1', '반도체');
  });

  it('두 콜백 다 없으면 우클릭 메뉴 자체가 안 뜬다', () => {
    renderFolder();
    fireEvent.contextMenu(header());
    expect(screen.queryByTestId('heatmap-group-menu')).toBeNull();
  });
});
