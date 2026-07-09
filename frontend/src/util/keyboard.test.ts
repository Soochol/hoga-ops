import { describe, it, expect, afterEach } from 'vitest';
import { shouldIgnoreEvent } from './keyboard';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldIgnoreEvent', () => {
  it('ignores form text controls (input/textarea/select)', () => {
    expect(shouldIgnoreEvent(el('<input />'))).toBe(true);
    expect(shouldIgnoreEvent(el('<textarea></textarea>'))).toBe(true);
    // SELECT 는 DrawingOverlay 의 옛 인라인 체크가 빠뜨렸던 케이스.
    expect(shouldIgnoreEvent(el('<select></select>'))).toBe(true);
  });

  it('ignores contentEditable elements', () => {
    const div = el('<div></div>');
    // jsdom 은 레이아웃 상속을 계산하지 않아 contentEditable='true' 를 설정해도
    // isContentEditable 이 false 로 읽힌다(실제 브라우저에선 정상). 함수 계약
    // "isContentEditable 이 true 면 무시" 자체를 검증하기 위해 프로퍼티를 직접 세팅.
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    expect(shouldIgnoreEvent(div)).toBe(true);
  });

  it('ignores anything inside [data-prevent-shortcuts]', () => {
    // 옛 인라인 체크가 빠뜨렸던 또 다른 케이스(예: 탭 오버플로 메뉴).
    const btn = el('<div data-prevent-shortcuts><button>x</button></div>')
      .querySelector('button') as HTMLElement;
    expect(shouldIgnoreEvent(btn)).toBe(true);
  });

  it('does not ignore ordinary interactive elements', () => {
    expect(shouldIgnoreEvent(el('<button>x</button>'))).toBe(false);
    expect(shouldIgnoreEvent(el('<div>x</div>'))).toBe(false);
    expect(shouldIgnoreEvent(el('<li role="button">x</li>'))).toBe(false);
  });

  it('does not ignore null or non-HTMLElement targets', () => {
    expect(shouldIgnoreEvent(null)).toBe(false);
    expect(shouldIgnoreEvent(document as unknown as EventTarget)).toBe(false);
  });
});
