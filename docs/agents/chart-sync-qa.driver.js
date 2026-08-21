// 창 간 동기화 QA 드라이버. `/browse js` 로 한 번 주입하면 이후 호출이 짧아진다.
//
// 이 세션에서 /browse 로 차트를 몰다 **잘못된 결론에 도달할 뻔한 세 지점**을
// 구조적으로 막는 것이 목적이다.
//   ① 좌표 조준 금지 — `elementFromPoint` 는 **맨 위** 요소를 준다. 창이 겹치는
//      워크스페이스에서는 뒤 창을 조준할 방법이 없고, 실제로 "그룹 게이트가 샌다"
//      라는 **거짓 결론**을 한 번 냈다(사실은 앞 창을 직접 휠질하고 있었다).
//   ② `hover` 금지 — 요소 **중심**을 노리므로 큰 캔버스가 가리면 5s 타임아웃.
//   ③ 단일 전역 금지 — `__liveChart` 는 마지막 생성 차트뿐. 창 id 레지스트리를 쓴다.
//
// 대신 `__liveCharts.get(id).chartElement()` 로 **그 창의 DOM 까지 내려가** 이벤트를
// 직접 dispatch 한다. 히트테스트를 안 거치므로 겹침과 무관하다.
window.__qa = {
  /** 워크스페이스 창 메타(localStorage) — id·kind·봉·그룹. */
  meta() {
    const w = JSON.parse(localStorage.getItem('live.workspace.v1') || '{}');
    return (w.windows || []).map((x) => ({
      id: x.id, kind: x.kind, tf: x.chart?.timeframe ?? null,
      group: x.group, pinned: x.pinned?.code ?? null,
      symbol: x.pinned?.code ?? w.groupSymbols?.[x.group]?.code ?? null,
    }));
  },
  /** 조건에 맞는 차트 창 하나의 id. 여럿이면 던진다 — 애매한 대상은 측정을 망친다. */
  find(pred) {
    const hit = this.meta().filter((m) => m.kind === 'chart' && pred(m));
    if (hit.length !== 1) throw new Error(`find: ${hit.length} matches`);
    return hit[0].id;
  },
  chart(id) {
    const c = window.__liveCharts?.get(id);
    if (!c) throw new Error(`chart: no handle for ${id}`);
    return c;
  },
  /** 그 창의 메인(캔들) 캔버스. `chartElement()` 를 거치므로 창 겹침과 무관하다. */
  canvas(id) {
    const el = this.chart(id).chartElement();
    const list = [...el.querySelectorAll('canvas')];
    if (!list.length) throw new Error(`canvas: none for ${id}`);
    return list.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
  },
  /** ⚠ 조작 전 반드시 부를 것 — 내가 쏘려는 요소가 정말 그 창인지 되묻는다. */
  verify(id) {
    const m = this.meta().find((x) => x.id === id);
    const r = this.canvas(id).getBoundingClientRect();
    const t = this.hit(id);
    return { tf: m?.tf, group: m?.group, symbol: m?.symbol,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      target: `${t.el.tagName}.${String(t.el.className || '').split(' ')[0]}` };
  },
  /** 논리 범위 — 위치와 폭을 함께 본다(둘 중 하나만 보면 팬과 줌이 구별되지 않는다). */
  range(id) {
    const r = this.chart(id).timeScale().getVisibleLogicalRange();
    return r ? { from: Math.round(r.from), span: Math.round(r.to - r.from) } : null;
  },
  _pt(id, fx = 0.5, fy = 0.5) {
    const r = this.canvas(id).getBoundingClientRect();
    return { x: Math.round(r.x + r.width * fx), y: Math.round(r.y + r.height * fy) };
  },
  /**
   * **이벤트 타깃**. 좌표는 그 창 기준으로 잡고, 실제 요소는 그 좌표의 요소 **스택**
   * 에서 이 차트 서브트리에 속한 첫 번째를 고른다.
   *
   * 왜 캔버스에 직접 쏘면 안 되는가: lwc 는 캔버스가 아니라 그 위에 덮인 **이벤트
   * 오버레이**에 리스너를 건다. 캔버스에 dispatch 하면 오버레이는 **조상이 아니라
   * 형제**라 버블링으로도 닿지 않는다(실측: 드래그·호버 둘 다 무반응).
   *
   * 왜 `elementFromPoint` 만으로는 안 되는가: 그건 **화면 맨 위** 요소를 준다.
   * 창이 겹치면 뒤 창을 조준할 수 없고, 앞 창을 조작해 놓고 뒤 창이 반응했다고
   * 오독하게 된다(이 세션에서 실제로 낸 거짓 결론).
   *
   * `elementsFromPoint`(복수) + 서브트리 필터가 그 둘을 동시에 푼다.
   */
  hit(id, fx = 0.5, fy = 0.5) {
    const p = this._pt(id, fx, fy);
    const root = this.chart(id).chartElement();
    const el = document.elementsFromPoint(p.x, p.y).find((e) => root.contains(e));
    if (!el) throw new Error(`hit: (${p.x},${p.y}) is not over chart ${id}`);
    return { el, x: p.x, y: p.y };
  },
  wheel(id, deltaY) {
    const p = this.hit(id); const el = p.el;
    el.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, deltaY, deltaMode: 0,
    }));
  },
  /** 드래그 팬. **한 태스크 안에서 끝난다** — 제품이 종료 flush 를 갖는지도 함께 잰다. */
  drag(id, dx, steps = 8) {
    const p = this.hit(id); const el = p.el;
    const o = (x, b) => ({ bubbles: true, clientX: x, clientY: p.y, button: 0, buttons: b,
      pointerType: 'mouse', pointerId: 1, isPrimary: true });
    el.dispatchEvent(new PointerEvent('pointerdown', o(p.x, 1)));
    el.dispatchEvent(new MouseEvent('mousedown', o(p.x, 1)));
    for (let i = 1; i <= steps; i++) {
      const x = p.x + Math.round((dx * i) / steps);
      el.dispatchEvent(new PointerEvent('pointermove', o(x, 1)));
      el.dispatchEvent(new MouseEvent('mousemove', o(x, 1)));
    }
    el.dispatchEvent(new PointerEvent('pointerup', o(p.x + dx, 0)));
    el.dispatchEvent(new MouseEvent('mouseup', o(p.x + dx, 0)));
  },
  /** lwc 크로스헤어용 enter+move 시퀀스(단일 mousemove 로는 안 걸린다). */
  hoverAt(id, fx = 0.5) {
    const p = this.hit(id, fx); const el = p.el;
    const P = (t, dx) => el.dispatchEvent(new PointerEvent(t, { bubbles: true,
      clientX: p.x + dx, clientY: p.y, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    const M = (t, dx) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: p.x + dx, clientY: p.y }));
    P('pointerover', 0); P('pointerenter', 0); P('pointermove', 0);
    M('mouseover', 0); M('mouseenter', 0); M('mousemove', 0);
    P('pointermove', 3); M('mousemove', 3);
  },
  /** 포인터를 차트 밖으로 — 대조 상태를 확보한다. */
  leave() {
    const n = document.querySelector('header') || document.body;
    n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 5, clientY: 5 }));
    n.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 5, clientY: 5, pointerType: 'mouse', pointerId: 1 }));
  },
  /**
   * 그 창 안에 크로스헤어 동기화 오버레이가 있는가 — **창 소속으로** 판정한다.
   *
   * ⚠ `chartElement().parentElement.querySelector(...)` 로 찾으면 **항상 false 다.**
   * 오버레이는 그 박스 아래가 아니라 pane 호스트 쪽에 붙는다. 그렇게 쓴 초판이
   * "크로스헤어가 안 온다" 는 **거짓 음성**을 냈다(2026-08-21 실측: 전역에는 1개가
   * 있었고 소속도 옳은 창이었다).
   *
   * 그래서 **문서에서 찾고 소속을 되묻는다** — 음성 결과를 믿기 전에 탐침이 양성을
   * 낼 수 있는지부터 확인하라는 규칙의 구현이다.
   */
  syncOverlay(id) {
    const root = this.chart(id).chartElement();
    const frame = root.closest('div.absolute');
    return [...document.querySelectorAll('[data-testid=study-cursor-sync]')]
      .some((n) => frame?.contains(n) || root.contains(n));
  },
  /** 오버레이 전수 — 어느 창에 몇 개 떠 있는지. 음성 판정 전에 이걸로 되묻는다. */
  syncOverlaysAll() {
    return [...document.querySelectorAll('[data-testid=study-cursor-sync]')].map((n) => {
      const f = n.closest('div.absolute');
      const r = f?.getBoundingClientRect();
      return r ? [Math.round(r.x), Math.round(r.y)] : null;
    });
  },
  toggle(labelFragment) {
    const r = [...document.querySelectorAll('*')]
      .find((e) => e.children.length === 0 && e.textContent && e.textContent.includes(labelFragment));
    const sw = r?.closest('[class*=justify-between]')?.querySelector('[role=switch]');
    if (!sw) throw new Error(`toggle: ${labelFragment} not found`);
    sw.click();
    return sw.getAttribute('aria-checked');
  },
};
'driver ready'
