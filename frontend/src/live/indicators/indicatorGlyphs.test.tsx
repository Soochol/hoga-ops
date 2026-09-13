import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { INDICATOR_GLYPH } from './indicatorGlyphs';
import { CATEGORIES } from './IndicatorPanel';

describe('INDICATOR_GLYPH', () => {
  // `Record<CategoryId, …>` 가 컴파일 타임에 이미 강제하지만, 그건 **타입에 있는**
  // 카테고리만 본다. 이 루프는 화면에 실제로 뜨는 표(`CATEGORIES`)와 대조한다 —
  // 둘이 갈리면(표에는 있는데 타입에 없거나 그 반대) 여기서 드러난다.
  it('CATEGORIES 의 15종 전부에 글리프가 있다', () => {
    expect(CATEGORIES).toHaveLength(15);
    for (const category of CATEGORIES) {
      expect(INDICATOR_GLYPH[category.id]).toBeTruthy();
    }
  });

  // 글리프는 장식이라 접근성 이름을 만들면 안 된다 — 행의 이름은 라벨 하나여야
  // `getByRole('button', { name })` 이 흔들리지 않는다.
  it('전부 aria-hidden 이라 접근성 이름을 오염시키지 않는다', () => {
    for (const category of CATEGORIES) {
      const { container, unmount } = render(<>{INDICATOR_GLYPH[category.id]}</>);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      unmount();
    }
  });

  // 색은 세 갈래(UI 상태 / 시스템 상태 / 시세 방향)로 엄격히 나뉜다. 글리프가 그중
  // 하나를 집으면 그 축이 흐려지므로 전부 `currentColor` 여야 한다.
  it('고정 색을 박지 않는다 — 전부 currentColor 를 따른다', () => {
    for (const category of CATEGORIES) {
      const { container, unmount } = render(<>{INDICATOR_GLYPH[category.id]}</>);
      for (const el of container.querySelectorAll('[fill], [stroke]')) {
        for (const attr of ['fill', 'stroke'] as const) {
          const value = el.getAttribute(attr);
          if (value == null) continue;
          expect(['currentColor', 'none']).toContain(value);
        }
      }
      unmount();
    }
  });

  // `<use href="#id">` 로 조각을 공유하면 nav 15행 + 미리보기 카드가 동시에 뜨는
  // 순간 문서에 같은 id 가 여럿 생기고, 그 `<use>` 는 **조용히 첫 정의만** 따라간다.
  it('전역 id 를 만들지 않는다 (use/symbol 금지)', () => {
    for (const category of CATEGORIES) {
      const { container, unmount } = render(<>{INDICATOR_GLYPH[category.id]}</>);
      expect(container.querySelectorAll('use')).toHaveLength(0);
      expect(container.querySelectorAll('symbol')).toHaveLength(0);
      expect(container.querySelectorAll('[id]')).toHaveLength(0);
      unmount();
    }
  });
});
