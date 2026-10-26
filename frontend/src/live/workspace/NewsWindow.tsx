import { useRef, useState, type ReactNode } from 'react';
import { DataControlPopover, ResponsiveDataControls } from '../../ui/ResponsiveDataControls';
import { useStockNews, type StockNewsItem, type StockNewsResponse } from '../../api/stockNews';

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function relation(item: StockNewsItem, code: string, name: string) {
  if (item.related_codes.includes(code)) return '종목코드 연결';
  if (name && item.title.includes(name)) return '제목에 종목명';
  return '조회 결과';
}

export function NewsWindow({ code, name }: { code: string; name: string }) {
  const [date, setDate] = useState('');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-card text-fg" data-testid="stock-news-window"
      style={{ colorScheme: 'var(--color-scheme)' }}>
      <NewsList key={`${code}:${date}`} code={code} name={name} date={date.replaceAll('-', '') || null}
        dateControls={<>
        <button type="button" aria-pressed={!date} onClick={() => setDate('')}
          className={`rounded px-2 py-1 text-sm ${!date ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-subtle'}`}>
          최신
        </button>
        <label className="flex min-w-0 items-center gap-1 text-sm text-fg-dim">
          날짜
          <input type="date" aria-label="뉴스 날짜" value={date} max={today}
            onChange={(event) => setDate(event.target.value)}
            className="ui-field" />
        </label>
        </>} />
    </div>
  );
}

function NewsList({ code, name, date, dateControls }: { code: string; name: string; date: string | null; dateControls: ReactNode }) {
  const query = useStockNews(code, date);
  const [snapshot, setSnapshot] = useState<StockNewsResponse | null>(null);
  const [linkedOnly, setLinkedOnly] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  // 첫 결과(실패 시 보존된 기사 포함)만 수용한다. 이후 배치는 읽던 목록을 밀지 않는다.
  if (!snapshot && query.data && (query.data.status === 'ok' || query.data.items.length > 0)) setSnapshot(query.data);
  const current = snapshot ?? query.data;
  const items = current?.items ?? [];
  const fresh = query.data?.status === 'ok' ? query.data : null;
  const existing = new Set(items.map((item) => item.id));
  const pending = fresh?.items.filter((item) => !existing.has(item.id)).length ?? 0;
  const shown = linkedOnly ? items.filter((item) => relation(item, code, name) !== '조회 결과') : items;
  const failed = query.isError || query.data?.status === 'error';
  const unconfigured = query.data?.status === 'unconfigured';

  const accept = () => {
    if (fresh) {
      setSnapshot(fresh);
      if (listRef.current) listRef.current.scrollTop = 0;
    }
  };

  return (
    <>
      <ResponsiveDataControls label="뉴스 설정" secondary={<>
        <label className="flex items-center gap-1 text-fg-dim" data-tooltip="응답의 종목코드 또는 제목의 종목명이 일치하는 기사만 표시합니다. 기사 내용의 관련성을 보장하지는 않습니다.">
          <input type="checkbox" checked={linkedOnly} onChange={(event) => setLinkedOnly(event.target.checked)} />
          종목 연결만
          <span className="text-fg-dim">{shown.length}건</span>
        </label>
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}
          className="rounded px-2 py-1 text-fg-dim hover:bg-bg-subtle disabled:opacity-50">
          {query.isFetching ? '조회 중…' : '새로고침'}
        </button>
      </>}>{dateControls}</ResponsiveDataControls>
      {pending > 0 && <button type="button" onClick={accept}
        className="shrink-0 border-b border-border bg-tint-selection px-2 py-2 text-sm text-accent">
        새 뉴스 {pending}건 · 목록에 반영
      </button>}
      {failed && <p role="status" className="shrink-0 border-b border-border px-2 py-2 text-sm text-fg-dim">
        뉴스 조회에 실패했습니다.{items.length > 0 ? ' 이전 결과를 표시합니다.' : ' 잠시 후 새로고침해주세요.'}
      </p>}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" aria-label={`${name} 뉴스 목록`}>
        {unconfigured && <p className="px-3 py-6 text-center text-sm text-fg-dim">
          한국투자 API 설정이 필요합니다.{items.length > 0 && ' 이전 결과를 표시합니다.'}
        </p>}
        {query.isPending && <p role="status" className="px-3 py-6 text-center text-sm text-fg-dim">뉴스를 불러오는 중입니다.</p>}
        {!unconfigured && !query.isPending && !failed && shown.length === 0 && <p className="px-3 py-6 text-center text-sm text-fg-dim">
          {linkedOnly && items.length > 0 ? '종목 연결 정보가 일치하는 기사가 없습니다.'
            : date ? '선택일 기사 없음 · 한국투자 조회 범위 기준' : '한국투자 조회 결과에 뉴스가 없습니다.'}
        </p>}
        {shown.map((item) => (
          <article key={item.id} className="select-text border-b border-border px-3 py-2">
            <p className="mb-1 break-words text-sm font-medium leading-relaxed">{item.title}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-dim">
              <span>{item.source}</span>
              <time dateTime={item.published_at_ms === null ? undefined : new Date(item.published_at_ms).toISOString()}>
                {item.published_at_ms === null ? '시각 미상' : timeFormat.format(item.published_at_ms)}
              </time>
              <span className={relation(item, code, name) === '조회 결과' ? 'text-fg-dim' : 'text-accent'}
                data-tooltip="한국투자 응답의 종목코드·제목 기준입니다. 기사 내용의 관련성과는 다를 수 있습니다.">
                {relation(item, code, name)}
              </span>
            </div>
          </article>
        ))}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-1 border-t border-border px-2 py-0.5 text-xs text-fg-dim">
        <span className="min-w-0 truncate">한국투자 · {date ? '선택일' : '최근'} 최대 {current?.limit ?? 40}건</span>
        <DataControlPopover label="뉴스 제공 안내">
        <p>한국투자 · {date ? '선택일' : '최근'} 최대 {current?.limit ?? 40}건 · 전체 기사 아님 · 원문 링크 미제공</p>
        <p data-tooltip="한국투자 종목 메타데이터에도 다른 종목 기사가 섞일 수 있습니다.">
          종목 연결은 제공 코드·제목 기준{!date && ' · 60초마다 확인'}
          {query.data?.fetched_at_ms != null && ` · 확인 ${timeFormat.format(query.data.fetched_at_ms)}`}
        </p>
        </DataControlPopover>
      </div>
    </>
  );
}
