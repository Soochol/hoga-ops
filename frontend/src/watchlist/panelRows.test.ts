import { describe, it, expect } from 'vitest';
import { mergePanelRows, memosOfFolder, toItemRefs, panelRowKey, type PanelRow } from './panelRows';
import type { WatchlistEntry, WatchlistMemo } from '../api/watchlist';

// 백엔드가 보내는 모양을 그대로 재현한다: entries 와 memos 는 **같은 축**(폴더 items
// 인덱스)의 order 를 갖고, 각 배열만 보면 띄엄띄엄하지만 합치면 0..N-1 로 조밀하다.
const entry = (code: string, order: number, folder = 'f_a'): WatchlistEntry => ({
  code, name: code, registered_at_kst_date: '20260101', last_success_date: null,
  folder_id: folder, order,
});
const memo = (id: string, order: number, text = '', folder = 'f_a'): WatchlistMemo => ({
  id, folder_id: folder, order, text,
});

describe('mergePanelRows', () => {
  it('sparse order 두 배열을 표시 순서로 되돌린다', () => {
    // items: [code A(0), memo(1), code B(2), memo(3)]
    const rows = mergePanelRows(
      [entry('005930', 0), entry('000660', 2)],
      [memo('m_00000001', 1, '실적 발표'), memo('m_00000002', 3)],
    );
    expect(rows.map(panelRowKey)).toEqual(['005930', 'm_00000001', '000660', 'm_00000002']);
  });

  it('메모가 없으면 종목 순서 그대로다(1단계 화면과 동일)', () => {
    const rows = mergePanelRows([entry('005930', 0), entry('000660', 1)], []);
    expect(rows.map(panelRowKey)).toEqual(['005930', '000660']);
  });

  it('메모만 있는 폴더도 그린다', () => {
    const rows = mergePanelRows([], [memo('m_00000001', 0, '메모만')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('memo');
  });

  it('입력 배열이 order 순이 아니어도 정렬한다 — order 는 정렬 키지 인덱스가 아니다', () => {
    const rows = mergePanelRows(
      [entry('000660', 2), entry('005930', 0)],
      [memo('m_00000001', 1)],
    );
    expect(rows.map(panelRowKey)).toEqual(['005930', 'm_00000001', '000660']);
  });
});

describe('memosOfFolder', () => {
  it('폴더로 거르고 order 순으로 준다', () => {
    const all = [memo('m_2', 5, '', 'f_a'), memo('m_x', 0, '', 'f_b'), memo('m_1', 1, '', 'f_a')];
    expect(memosOfFolder(all, 'f_a').map((m) => m.id)).toEqual(['m_1', 'm_2']);
  });
});

describe('toItemRefs', () => {
  it('화면 순서를 서버 재배열 계약으로 옮긴다 — 메모는 id, 종목은 code', () => {
    const rows: PanelRow[] = [
      { kind: 'entry', entry: entry('005930', 0) },
      { kind: 'memo', memo: memo('m_00000001', 1, '구분') },
    ];
    expect(toItemRefs(rows)).toEqual([
      { kind: 'code', code: '005930' },
      { kind: 'memo', id: 'm_00000001' },
    ]);
  });

  it('메모 text 를 싣지 않는다 — 재배열은 내용을 옮기지 않는다', () => {
    const refs = toItemRefs([{ kind: 'memo', memo: memo('m_00000001', 0, '긴 메모 내용') }]);
    expect(refs[0]).not.toHaveProperty('text');
  });
});
