import { AppIcon } from './AppIcon';

/** 재수집(회전 화살표) 아이콘 — 종목 하나를 다시 수집하는 액션용 14px 공통 글리프.
 *  ChevronIcon·TrashIcon·PencilIcon 과 같은 중립 ui/ 프리미티브(ADR-0110 의 이관 근거).
 *  유니코드 `↻` 를 대체한다.
 *
 *  **회전 애니메이션은 이 아이콘에 건다**(`className="animate-spin"`) — 감싸는 버튼에
 *  걸면 패딩까지 함께 돌고, 문자 글리프 시절엔 baseline 기준이라 회전축이 글자 아래로
 *  치우쳤다. SVG 는 viewBox 중심으로 돌아 축이 맞는다. */
export function RefreshIcon({ className = '' }: { className?: string }) {
  return <AppIcon name="refresh" className={className} />;
}
