import { describe, expect, it } from 'vitest';
import { studyDocumentTitle } from './studyDocumentTitle';

const save = { label: '삼성전자', code: '005930', name: '돌파 복기' };
const active = { label: 'SK하이닉스', code: '000660', name: '눌림 복기' };

describe('studyDocumentTitle', () => {
  it('joins the symbol name and the saved view name', () => {
    expect(studyDocumentTitle(save, null)).toBe('삼성전자 돌파 복기');
  });

  it('prefers the server save over the persisted active view', () => {
    // 필드별로 섞지 않는다 — 이름 변경(rename) 직후 스토어의 `name` 은 stale 이라
    // 섞으면 새 이름 옆에 옛 라벨이 붙는 조합이 나온다.
    expect(studyDocumentTitle(save, active)).toBe('삼성전자 돌파 복기');
  });

  it('falls back to the active-view store while saves are still loading', () => {
    expect(studyDocumentTitle(null, active)).toBe('SK하이닉스 눌림 복기');
  });

  it('falls back to the code when the saved symbol label is empty', () => {
    expect(studyDocumentTitle({ ...save, label: '  ' }, null)).toBe('005930 돌파 복기');
  });

  it('drops the trailing separator when the view has no name', () => {
    expect(studyDocumentTitle({ ...save, name: '   ' }, null)).toBe('삼성전자');
  });

  it('uses the nav label when no view is open', () => {
    expect(studyDocumentTitle(null, null)).toBe('복기');
  });

  it('uses the nav label when the source identifies no symbol', () => {
    // 종목을 못 읽는 제목(뷰 이름만 남은 탭)은 「복기」보다 나쁘다.
    expect(studyDocumentTitle({ label: '', code: '', name: '돌파 복기' }, null)).toBe('복기');
  });
});
