/**
 * /study 창 kind 메타 (ADR-0123 PR-3) — 라벨·testid 상수.
 *
 * 컴포넌트 파일(react-refresh 규율상 컴포넌트만 export)과 분리된 순수 모듈.
 * 공통 kind 라벨은 /live 의 SSOT(`windowKindLabels`)를 재사용한다 — 같은 카드
 * 컴포넌트를 렌더하므로 "고른 것 = 생긴 것" 약속도 페이지를 넘어 하나여야 한다.
 */
import { WINDOW_KIND_LABEL } from '../live/workspace/windowKindLabels';
import type { StudyWindowKind } from '../state/studyWorkspace';

export type StudyDataWindowKind = Exclude<StudyWindowKind, 'chart' | 'memo'>;

export const STUDY_WINDOW_LABEL: Record<StudyWindowKind, string> = {
  chart: WINDOW_KIND_LABEL.chart,
  book: WINDOW_KIND_LABEL.book,
  broker: WINDOW_KIND_LABEL.broker,
  vdist: WINDOW_KIND_LABEL.vdist,
  program: WINDOW_KIND_LABEL.program,
  memo: '메모',
};

/** 데이터 창 testid 조각 — 구 카드 계약(`study-detail-card-*`)을 창에서 승계한다. */
export const STUDY_DATA_WINDOW_TEST_ID: Record<StudyDataWindowKind, string> = {
  book: 'orderbook',
  broker: 'brokers',
  vdist: 'volume-distribution',
  program: 'program',
};
