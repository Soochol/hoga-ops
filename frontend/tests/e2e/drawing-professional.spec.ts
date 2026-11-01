import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, Logical } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import type { Drawing } from '../../src/chart/drawing/types';

type ChartHost = Window & { __liveCharts: Map<string,IChartApi> };
const scope='098460|minute';
async function read(page:Page) {
  return page.evaluate(async scope=>{
    const path='/src/state/drawings.ts';
    const {useDrawingsStore}=await import(path) as typeof import('../../src/state/drawings');
    const s=useDrawingsStore.getState();return {tool:s.activeTool,items:s.drawingsFor(scope),selected:s.selectedFor(scope)};
  },scope);
}
async function setup(page:Page) {
  await installLiveMocks(page);await page.goto('/live?code=098460');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  const id:string=await page.evaluate(async()=>{
    const path='/src/state/workspace.ts';const {useWorkspaceStore}=await import(path);
    const s=useWorkspaceStore.getState(), w=s.windows.find((w:{kind:string})=>w.kind==='chart');
    s.setChartTimeframe(w.id,'3m');s.focusWindow(w.id);s.toggleMaximize(w.id);return w.id;
  });
  await expect.poll(()=>page.evaluate(id=>(window as unknown as ChartHost).__liveCharts?.get(id)?.panes()[0].getSeries().find(s=>s.seriesType()==='Candlestick')?.data().length ?? 0,id)).toBeGreaterThan(0);
  await page.evaluate(id=>(window as unknown as ChartHost).__liveCharts.get(id)!.timeScale().setVisibleLogicalRange({from:-2,to:5}),id);
  await expect.poll(()=>page.evaluate(id=>(window as unknown as ChartHost).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange()?.to,id)).toBeCloseTo(5);
  return page.evaluate(id=>{
    const chart=(window as unknown as ChartHost).__liveCharts.get(id)!;
    const box=document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
    return {x:box.left+Number(chart.timeScale().logicalToCoordinate(0 as Logical)),
      x2:box.left+Number(chart.timeScale().logicalToCoordinate(1 as Logical)),
      y:box.top+chart.panes()[0].getHeight()*0.62,y2:box.top+chart.panes()[0].getHeight()*0.38};
  },id);
}
async function choose(page:Page,label:string) {
  await page.getByTestId('drawing-menu-trigger').first().click();
  const menu=page.getByRole('dialog',{name:'그리기 도구'});
  await menu.getByRole('button',{name:'도구',exact:true}).click();
  await menu.getByLabel('그리기 도구 검색').fill(label);
  await menu.getByRole('button',{name:label,exact:true}).click();
  await expect(menu).toBeHidden();
}
for (const [kind,label] of [['hray','수평 레이'],['fib','피보나치 되돌림'],['channel','평행 채널'],['long-position','롱 포지션'],['short-position','숏 포지션']] as const) {
  test(`${label}: create, edit coordinates, duplicate, undo and persist`,async({page},info)=>{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const g=await setup(page);await choose(page,label);
    await page.mouse.move(g.x,g.y);await page.mouse.down();
    if(kind!=='hray')await page.mouse.move(g.x2,g.y2,{steps:6});
    await page.mouse.up();
    if(kind==='channel') {await expect.poll(async()=>(await read(page)).items.length).toBe(0);await page.mouse.click(g.x2,g.y2+60);}
    await expect.poll(async()=>(await read(page)).items.map(d=>d.kind)).toEqual([kind]);
    await expect.poll(async()=>(await read(page)).tool).toBe('select');
    await expect(page.getByTestId('drawing-property-panel')).toBeVisible();
    if(kind!=='hray') {
      // Endpoint handles must remain reachable at their projected positions.
      const before=(await read(page)).items[0] as Extract<Drawing,{kind:typeof kind}>;
      const handleY=kind==='short-position'?g.y+(g.y-g.y2):g.y2;
      {
        await page.mouse.move(g.x2,handleY);await page.mouse.down();await page.mouse.move(g.x2,handleY+(kind==='short-position'?12:-12),{steps:4});await page.mouse.up();
        await expect.poll(async()=>((await read(page)).items[0] as {b:{price:number}}).b.price).not.toBe((before as {b:{price:number}}).b.price);
      }
    }
    await page.getByRole('button',{name:'그리기 세부 설정'}).click();
    await page.getByLabel('그리기 이름').fill(`${label} 검토`);
    const valueField=page.getByLabel(kind==='long-position'||kind==='short-position'?'진입 가격':'시작 가격',{exact:true});
    await expect(valueField).toBeVisible();
    const editedPrice=Number(await valueField.inputValue())+0.125;
    await valueField.fill(String(editedPrice));
    await page.getByRole('button',{name:'이름 · 좌표 적용'}).click();
    await expect.poll(async()=>(await read(page)).items[0].name).toBe(`${label} 검토`);
    await expect.poll(async()=>{const d=(await read(page)).items[0];return d.kind==='hray'?d.at.price:'a' in d?d.a.price:null;}).toBe(editedPrice);
    await page.getByRole('button',{name:'스타일 저장',exact:true}).click();
    await expect(page.getByLabel('스타일 템플릿').getByRole('option',{name:`${label} 검토`})).toBeAttached();
    await page.screenshot({path:info.outputPath(`${kind}-settings.png`)});
    await page.getByRole('button',{name:'그리기 세부 설정'}).click();
    await page.keyboard.press('Control+d');await expect.poll(async()=>(await read(page)).items.length).toBe(2);
    await page.keyboard.press('Control+z');await expect.poll(async()=>(await read(page)).items.length).toBe(1);
    const saved=(await read(page)).items;
    await expect.poll(()=>page.evaluate(({scope,saved})=>JSON.parse(localStorage.getItem(`replay.drawings.v2.${scope}`)||'null')?.items?.[0]?.name===saved[0].name,{scope,saved})).toBe(true);
    await page.reload();await expect.poll(async()=>(await read(page)).items).toEqual(saved);
    expect(errors).toEqual([]);
  });
}

test('quick menu: favorite, repeat mode, list, narrow viewport and channel cancellation',async({page},info)=>{
  const g=await setup(page);
  await page.getByTestId('drawing-menu-trigger').first().click();
  let menu=page.getByRole('dialog',{name:'그리기 도구'});
  await menu.getByLabel('롱 포지션 즐겨찾기',{exact:true}).click();
  await expect(menu.getByRole('button',{name:'롱 포지션 즐겨찾기 실행'})).toBeVisible();
  await menu.getByLabel('연속 그리기',{exact:true}).check();
  await menu.getByRole('button',{name:'수평 레이',exact:true}).click();
  await page.mouse.click(g.x,g.y);await page.mouse.click(g.x2,g.y2);
  await expect.poll(async()=>(await read(page)).items.length).toBe(2);
  await expect.poll(async()=>(await read(page)).tool).toBe('hray');
  await page.keyboard.press('Escape');
  await page.getByTestId('drawing-menu-trigger').first().click();
  await menu.getByRole('button',{name:'그리기 목록 2',exact:true}).click();
  await menu.getByRole('button',{name:'수평 레이 숨기기',exact:true}).first().click();
  await expect.poll(async()=>(await read(page)).items[0].hidden).toBe(true);
  await menu.getByRole('button',{name:'수평 레이 잠금',exact:true}).first().click();
  await expect(menu.getByRole('button',{name:'수평 레이 표시',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await choose(page,'평행 채널');await page.mouse.move(g.x,g.y);await page.mouse.down();await page.mouse.move(g.x2,g.y2,{steps:4});await page.mouse.up();
  await page.keyboard.press('Escape');await page.mouse.click(g.x2,g.y2+60);
  await expect.poll(async()=>(await read(page)).items.length).toBe(2);
  await page.setViewportSize({width:360,height:740});
  await page.getByTestId('drawing-menu-trigger').first().click();
  menu=page.getByRole('dialog',{name:'그리기 도구'});await expect(menu).toBeVisible();
  const box=(await menu.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(360);expect(box.y+box.height).toBeLessThanOrEqual(740);
  await page.screenshot({path:info.outputPath('quick-menu-narrow.png')});
});

test('trendline extensions are rendered and selectable beyond the original endpoints',async({page},info)=>{
  const g=await setup(page);await choose(page,'추세선');
  await page.mouse.move(g.x,g.y);await page.mouse.down();await page.mouse.move(g.x2,g.y2,{steps:6});await page.mouse.up();
  await expect.poll(async()=>(await read(page)).items.map(d=>d.kind)).toEqual(['trendline']);
  await page.getByRole('button',{name:'그리기 세부 설정'}).click();
  await page.getByLabel('왼쪽 연장',{exact:true}).check();
  await page.getByLabel('우측 연장',{exact:true}).check();
  await page.getByRole('button',{name:'그리기 세부 설정'}).click();
  await page.mouse.move(g.x2+(g.x2-g.x)*0.3,g.y2+(g.y2-g.y)*0.3);
  await expect(page.locator('[data-drawing-overlay]').first()).toHaveCSS('pointer-events','auto');
  await page.mouse.down();await page.mouse.up();
  await expect.poll(async()=>(await read(page)).items[0]).toMatchObject({kind:'trendline',extendLeft:true,extendRight:true});
  await page.screenshot({path:info.outputPath('trendline-extended.png')});
});
