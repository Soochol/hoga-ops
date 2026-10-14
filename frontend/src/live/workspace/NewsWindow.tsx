import { useRef, useState } from 'react';
import { useStockNews, type StockNewsItem, type StockNewsResponse } from '../../api/stockNews';
import { useThemePrefsStore } from '../../state/themePrefs';

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
  const dark = useThemePrefsStore((state) => state.themePreference === 'toss-dark' || state.themePreference === 'obsidian');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-card text-fg" data-testid="stock-news-window"
      style={{ colorScheme: dark ? 'dark' : 'light' }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
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
      </div>
      <NewsList key={`${code}:${date}`} code={code} name={name} date={date.replaceAll('-', '') || null} />
    </div>
  );
}

function NewsList({ code, name, date }: { code: string; name: string; date: string | null }) {
  const query = useStockNews(code, date);
  const [snapshot, setSnapshot] = useState<StockNewsResponse | null>(null);
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
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
      setSelected(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border px-2 py-1 text-sm">
        <label className="flex items-center gap-1 text-fg-dim" title="응답의 종목코드 또는 제목의 종목명이 일치하는 기사만 표시합니다. 기사 내용의 관련성을 보장하지는 않습니다.">
          <input type="checkbox" checked={linkedOnly} onChange={(event) => setLinkedOnly(event.target.checked)} />
          종목 연결만
          <span className="text-fg-dim">{shown.length}건</span>
        </label>
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}
          className="rounded px-2 py-1 text-fg-dim hover:bg-bg-subtle disabled:opacity-50">
          {query.isFetching ? '조회 중…' : '새로고침'}
        </button>
      </div>
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
          <article key={item.id} className="border-b border-border">
            <button type="button" aria-expanded={selected === item.id} onClick={() => setSelected(selected === item.id ? null : item.id)}
              className={`w-full px-3 py-2 text-left hover:bg-bg-subtle ${selected === item.id ? 'bg-tint-selection' : ''}`}>
              <p className="mb-1 break-words text-sm font-medium leading-relaxed">{item.title}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-dim">
                <span>{item.source}</span>
                <time dateTime={item.published_at_ms === null ? undefined : new Date(item.published_at_ms).toISOString()}>
                  {item.published_at_ms === null ? '시각 미상' : timeFormat.format(item.published_at_ms)}
                </time>
                <span className={relation(item, code, name) === '조회 결과' ? 'text-fg-dim' : 'text-accent'}
                  title="한국투자 응답의 종목코드·제목 기준입니다. 기사 내용의 관련성과는 다를 수 있습니다.">
                  {relation(item, code, name)}
                </span>
              </div>
            </button>
            {selected === item.id && <div className="px-3 pb-2 text-sm text-fg-dim">
              제공 종목코드: {item.related_codes.join(' · ') || '없음'}
              <p className="mt-1">제목만 제공되는 뉴스입니다. 원문·본문은 제공되지 않습니다.</p>
            </div>}
          </article>
        ))}
      </div>
      <div className="shrink-0 border-t border-border px-2 py-1.5 text-xs text-fg-dim">
        <p>한국투자 · {date ? '선택일' : '최근'} 최대 {current?.limit ?? 40}건 · 전체 기사 아님 · 원문 링크 미제공</p>
        <p title="한국투자 종목 메타데이터에도 다른 종목 기사가 섞일 수 있습니다.">
          종목 연결은 제공 코드·제목 기준{!date && ' · 60초마다 확인'}
          {query.data?.fetched_at_ms != null && ` · 확인 ${timeFormat.format(query.data.fetched_at_ms)}`}
        </p>
      </div>
    </>
  );
}
