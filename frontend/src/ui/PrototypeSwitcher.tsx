/**
 * ⚠ PROTOTYPE — throwaway. `/prototype` 스킬의 변형 전환 바.
 *
 * 화면 하단 중앙 고정. ←/→ 로 변형을 순환하고 URL `?variant=` 를 갱신하므로
 * 새로고침·공유에도 살아남는다. 평가 대상 디자인과 헷갈리지 않도록 일부러
 * 시스템 톤을 벗어난 고대비 알약으로 그린다. 프로덕션 빌드에선 렌더하지 않는다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

export function PrototypeSwitcher({
  variants,
  labels,
  notes,
  param,
  extras,
}: {
  variants: readonly string[];
  labels: Record<string, string>;
  notes?: Record<string, string>;
  param: string;
  /** 변형과 독립된 부가 토글(예: 이후 구간 노출). */
  extras?: readonly { param: string; label: string; on: boolean }[];
}) {
  const [params, setParams] = useSearchParams();
  const current = variants.includes(params.get(param) ?? '') ? (params.get(param) as string) : variants[0];

  const go = (delta: number) => {
    const idx = variants.indexOf(current);
    const next = variants[(idx + delta + variants.length) % variants.length];
    const nextParams = new URLSearchParams(params);
    nextParams.set(param, next);
    setParams(nextParams, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div
      data-testid="prototype-switcher"
      style={{
        position: 'fixed',
        left: '50%',
        // 변형 C 의 하단 미니맵 레일(≈70px)을 가리지 않도록 띄운다.
        bottom: 110,
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 999,
        background: '#111114',
        color: '#f5f5f7',
        border: '1px solid #3d3d46',
        boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <button type="button" onClick={() => go(-1)} style={arrowStyle} aria-label="이전 변형">
        ←
      </button>
      <div style={{ minWidth: 240, textAlign: 'center' }}>
        <div style={{ fontWeight: 600 }}>{labels[current] ?? current}</div>
        {notes?.[current] && <div style={{ opacity: 0.62, fontSize: 11 }}>{notes[current]}</div>}
      </div>
      <button type="button" onClick={() => go(1)} style={arrowStyle} aria-label="다음 변형">
        →
      </button>
      {extras?.map((x) => (
        <button
          key={x.param}
          type="button"
          onClick={() => {
            const nextParams = new URLSearchParams(params);
            if (x.on) nextParams.delete(x.param);
            else nextParams.set(x.param, '1');
            setParams(nextParams, { replace: true });
          }}
          style={{
            ...arrowStyle,
            width: 'auto',
            padding: '2px 8px',
            background: x.on ? '#f5f5f7' : 'transparent',
            color: x.on ? '#111114' : '#f5f5f7',
          }}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

const arrowStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 999,
  border: '1px solid #3d3d46',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  lineHeight: 1,
};

export default PrototypeSwitcher;
