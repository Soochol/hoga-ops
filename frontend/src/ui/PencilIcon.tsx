import { AppIcon } from './AppIcon';

/** 이름 변경(연필) 아이콘 — 컨텍스트 메뉴 항목용 14px 공통 글리프.
 *  ChevronIcon·TrashIcon 과 같은 중립 ui/ 프리미티브(ADR-0110 의 이관 근거).
 *  히트맵·저장뷰·관심종목 드로어가 각자 같은 path 를 복제해 갖고 있었다 — 그 이관은
 *  한동안 미완이어서 이 파일이 생긴 뒤에도 지역 사본 3개가 남아 있었다. 지금은 네 소비처
 *  (HeatmapGroupMenu·HeatmapDrawer·StudyViewRowMenu·WatchlistDrawer)가 모두 이걸 쓴다. */
export function PencilIcon({ className = '' }: { className?: string }) {
  return <AppIcon name="pencil" className={className} />;
}
