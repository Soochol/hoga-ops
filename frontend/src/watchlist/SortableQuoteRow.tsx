import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { QuoteRow, type QuoteRowProps } from '../rightrail/QuoteRow';

/**
 * `useSortable`를 캡슐화해 `QuoteRow`에 drag props만 주입한다. 스크리너 드로어는
 * bare `QuoteRow`를 그대로 쓰므로, 정렬 가능 여부는 이 래퍼를 쓰는지로 결정된다.
 * `id`는 안정적인 종목 코드(=SortableContext items와 일치).
 */
export function SortableQuoteRow(
  { code, ...rowProps }: { code: string } & QuoteRowProps,
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: code });
  return (
    <QuoteRow
      {...rowProps}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
    />
  );
}
