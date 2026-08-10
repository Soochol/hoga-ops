/**
 * PROTOTYPE — 변형 전환 플로팅 바. 던져버릴 코드다.
 *
 * URL 이 진실이라 새로고침·공유가 그대로 된다. `?view=` 를 보존해야 하므로
 * `URLSearchParams` 에서 **자기 키만** 만진다.
 *
 * 디자인 시스템을 일부러 벗어난 모양(고대비 pill)이다 — 평가 대상인 오버레이와
 * 헷갈리면 안 된다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import {
  PROTO_PARAM,
  PROTO_VARIANTS,
  PROTO_VARIANT_NAMES,
  parseProtoVariant,
  useStudyCursorSyncProtoStore,
  type ProtoVariant,
} from './studyCursorSyncProto';

export function StudyPrototypeSwitcher() {
  const [params, setParams] = useSearchParams();
  const variant = parseProtoVariant(params.get(PROTO_PARAM));
  const setVariant = useStudyCursorSyncProtoStore((s) => s.setVariant);

  // URL → 스토어. 오버레이는 `LiveChartRoot` 깊숙이 있어 prop 으로 못 내린다.
  useEffect(() => { setVariant(variant); }, [variant, setVariant]);

  useEffect(() => {
    if (!variant) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      const i = PROTO_VARIANTS.indexOf(variant);
      const next = PROTO_VARIANTS[
        (i + (e.key === 'ArrowRight' ? 1 : PROTO_VARIANTS.length - 1)) % PROTO_VARIANTS.length
      ];
      const nextParams = new URLSearchParams(params);
      nextParams.set(PROTO_PARAM, next);
      setParams(nextParams, { replace: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant, params, setParams]);

  // 프로덕션 빌드에는 절대 뜨지 않게. 파라미터가 없으면 `/study` 는 평소 그대로다.
  if (!import.meta.env.DEV || !variant) return null;

  const go = (dir: 1 | -1) => {
    const i = PROTO_VARIANTS.indexOf(variant);
    const next = PROTO_VARIANTS[(i + dir + PROTO_VARIANTS.length) % PROTO_VARIANTS.length];
    const nextParams = new URLSearchParams(params);
    nextParams.set(PROTO_PARAM, next);
    setParams(nextParams, { replace: true });
  };

  return (
    <div
      data-testid="study-prototype-switcher"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 6px',
        borderRadius: 999,
        background: '#111',
        color: '#fff',
        border: '1px solid #555',
        boxShadow: '0 4px 16px rgba(0,0,0,.5)',
        fontSize: 12,
        fontFamily: 'var(--font-data)',
      }}
    >
      <ArrowButton label="◀" onClick={() => go(-1)} />
      <span style={{ padding: '0 8px', whiteSpace: 'nowrap' }}>
        PROTO {variant} — {PROTO_VARIANT_NAMES[variant as ProtoVariant]}
      </span>
      <ArrowButton label="▶" onClick={() => go(1)} />
    </div>
  );
}

function ArrowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        borderRadius: 999,
        background: '#333',
        color: '#fff',
        border: 'none',
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}
