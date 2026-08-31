/**
 * ShortcutHelpModal — 단축키 도움말 (2026-08-04 UI 조사 #8: 발견성 0 해소).
 *
 * `/live` 에 j·k·w·n·[·]·Shift+1~4·⌥그리기 단축키가 있는데 화면 표기는 검색창의
 * `/` 힌트뿐이었다. `?` 키(전 라우트) 또는 `/live` 툴바의 [단축키] 버튼으로 여는
 * 라우트 인지형 목록 — 현재 라우트의 단축키 섹션만 보여준다.
 *
 * 그리기 도구 목록은 tools.ts 의 spec(shortcut 필드)에서 **동적으로** 읽는다 —
 * DrawingMenu 가 이미 같은 spec 을 그리므로 여기 하드코딩하면 두 진실이 된다.
 * 다만 tools.ts 는 live-workspace 청크 소속이라 App 전역 호스트에서 정적 import
 * 하면 초기 로드에 끌려온다 — 모달이 열릴 때 dynamic import 로 지연 로드한다.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { ModalShell } from './ModalShell';
import { shouldIgnoreEvent } from '../util/keyboard';
import { onOpenShortcutHelp } from './shortcutHelp';

type HelpRoute = 'live' | 'heatmap' | 'other';

function routeOf(pathname: string): HelpRoute {
  if (pathname.startsWith('/live')) return 'live';
  if (pathname.startsWith('/heatmap')) return 'heatmap';
  return 'other';
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-strong bg-bg-input px-1 font-data text-xs text-fg-dim">
      {children}
    </kbd>
  );
}

function Row({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <>
      <span className="flex items-center gap-1 justify-self-start whitespace-nowrap">
        {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
      </span>
      <span className="text-sm text-fg-dim">{desc}</span>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-fg-dim">{title}</h3>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
        {children}
      </div>
    </section>
  );
}

type DrawShortcut = { key: string; label: string };

export function ShortcutHelpModal({ route, onClose }: { route: HelpRoute; onClose: () => void }) {
  // 그리기 단축키는 열렸을 때만 지연 로드(위 헤더 주석 — 초기 번들 보호).
  const [drawTools, setDrawTools] = useState<DrawShortcut[] | null>(null);
  useEffect(() => {
    if (route !== 'live') return undefined;
    let alive = true;
    import('../chart/drawing/tools').then((m) => {
      if (!alive) return;
      setDrawTools(
        Object.values(m.TOOLS)
          .filter((t) => t.shortcut)
          .map((t) => ({ key: t.shortcut!.key.toUpperCase(), label: t.label })),
      );
    });
    return () => { alive = false; };
  }, [route]);

  return (
    <ModalShell ariaLabel="단축키 도움말" title="단축키" width="w-[440px]" onClose={onClose}>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto px-4 py-4">
        {route === 'live' && (
          <>
            <Section title="live 워크스페이스">
              <Row keys={['/']} desc="종목 검색" />
              <Row keys={['j', 'k']} desc="관심종목 다음/이전 종목" />
              <Row keys={['w']} desc="관심종목 패널 토글" />
              <Row keys={['n']} desc="활성 그룹에 차트 창 추가" />
              <Row keys={['[', ']']} desc="창 포커스 순환" />
              <Row keys={['⇧1', '~', '⇧4']} desc="포커스 창 봉 전환 (분·일·주·월)" />
            </Section>
            <Section title="그리기">
              {(drawTools ?? []).map((t) => (
                <Row key={t.key} keys={[`⌥${t.key}`]} desc={t.label} />
              ))}
              <Row keys={['⇧클릭']} desc="선택에 더하기/빼기" />
              <Row keys={['⇧드래그']} desc="범위로 여러 개 선택" />
              <Row keys={['↑', '↓', '←', '→']} desc="선택 미세 이동 (⇧ 크게)" />
              <Row keys={['Del']} desc="선택한 그리기 삭제" />
              <Row keys={['Ctrl', 'A']} desc="이 차트의 그리기 전체 선택" />
              <Row keys={['Ctrl', 'D']} desc="선택 복제" />
              <Row keys={['Ctrl', 'Z']} desc="실행취소 (⇧ 다시실행)" />
              <Row keys={['⌥C']} desc="모두 지우기" />
            </Section>
          </>
        )}
        {route === 'heatmap' && (
          <Section title="히트맵">
            <Row keys={['/']} desc="검색 포커스" />
          </Section>
        )}
        <Section title="공통">
          <Row keys={['?']} desc="이 도움말 열기/닫기" />
          <Row keys={['Esc']} desc="모달·팝오버 닫기" />
        </Section>
      </div>
    </ModalShell>
  );
}

/** App 전역 호스트 — `?` 키와 openShortcutHelp() 채널을 받아 모달을 띄운다. */
export function ShortcutHelpHost() {
  const [open, setOpen] = useState(false);
  const route = routeOf(useLocation().pathname);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // '?' 는 Shift+/ 라 shiftKey 는 걸러내지 않는다. 입력 필드에서는 리터럴 타이핑.
      if (e.key !== '?' || shouldIgnoreEvent(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      setOpen((o) => !o);
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => onOpenShortcutHelp(() => setOpen(true)), []);

  if (!open) return null;
  return <ShortcutHelpModal route={route} onClose={() => setOpen(false)} />;
}
