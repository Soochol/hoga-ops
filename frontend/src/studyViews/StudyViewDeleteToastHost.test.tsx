import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import StudyViewDeleteToastHost from './StudyViewDeleteToastHost';
import { useStudyViewDeletion } from './studyViewDeletion';

const row = (id: string): StudyViewReference => ({
  id, schema_version: 2, name: id, code: '005930', label: '삼성전자', timeframe: '5m', memo: '', tags: [],
  range: { from_date: '20260901', to_date: '20260901', from_ms: 1000, to_ms: 2000 },
  viewport: { right_edge_ms: 2000, bar_span: 10, at_live_edge: false }, created_at_ms: 1, updated_at_ms: 1,
});

afterEach(() => {
  for (const batch of useStudyViewDeletion.getState().batches) useStudyViewDeletion.getState().undo(batch.id);
  vi.useRealTimers();
});

it('keeps consecutive undo actions available and brings the newest request into view', () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  render(<StudyViewDeleteToastHost />);
  expect(screen.queryByRole('region', { name: '저장뷰 삭제 알림 목록' })).not.toBeInTheDocument();
  act(() => {
    for (let i = 0; i < 20; i++) useStudyViewDeletion.getState().queue([row(`저장뷰 ${i}`)], client);
  });
  const list = screen.getByRole('region', { name: '저장뷰 삭제 알림 목록' });
  expect(within(list).getAllByRole('button', { name: '실행 취소' })).toHaveLength(20);
  expect(within(list).getAllByRole('status')[0]).toHaveTextContent('‘저장뷰 19’');
  list.scrollTop = 200;
  act(() => useStudyViewDeletion.getState().queue([row('가장 최근 요청')], client));
  expect(list.scrollTop).toBe(0);
  const newest = within(list).getAllByRole('status')[0];
  expect(newest).toHaveTextContent('‘가장 최근 요청’');
  fireEvent.click(within(newest).getByRole('button', { name: '실행 취소' }));
  expect(useStudyViewDeletion.getState().batches).toHaveLength(20);
  expect(useStudyViewDeletion.getState().batches.some((batch) => batch.rows[0].id === '가장 최근 요청')).toBe(false);
  expect(within(list).getAllByRole('status')[0]).toHaveTextContent('‘저장뷰 19’');
  act(() => {
    for (const batch of useStudyViewDeletion.getState().batches) useStudyViewDeletion.getState().undo(batch.id);
  });
  expect(screen.queryByRole('region', { name: '저장뷰 삭제 알림 목록' })).not.toBeInTheDocument();
  client.clear();
});
