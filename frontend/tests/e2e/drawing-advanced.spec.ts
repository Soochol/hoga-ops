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
  await installLiveMocks(page);
  await page.route(/^https?:\/\/[^/]+\/api\/live\/past-candles/, route => route.fulfill({json:{
    code:'098460',from:'20260527',to:'20260527',cached_dates:['20260527'],fresh_dates:[],data_warnings:[],
    candles:[35000,35080,35030,35160,35180].map((close,i)=>({t_ms:1779840000000+i*60000,open:close-30,high:close+80,low:close-80,close,volume:100})),
  }}));
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  const id:string=await page.evaluate(async()=>{
    const path='/src/state/workspace.ts';const {useWorkspaceStore}=await import(path);
    const s=useWorkspaceStore.getState(), w=s.windows.find((w:{kind:string})=>w.kind==='chart');
    s.setChartTimeframe(w.id,'1m');s.focusWindow(w.id);s.toggleMaximize(w.id);return w.id;
  });
  await expect.poll(()=>page.evaluate(id=>(window as unknown as ChartHost).__liveCharts?.get(id)?.panes()[0].getSeries().find(s=>s.seriesType()==='Candlestick')?.data().length ?? 0,id)).toBeGreaterThan(0);
  await page.evaluate(id=>(window as unknown as ChartHost).__liveCharts.get(id)!.timeScale().setVisibleLogicalRange({from:-1,to:7}),id);
  await expect.poll(()=>page.evaluate(id=>(window as unknown as ChartHost).__liveCharts.get(id)!.timeScale().getVisibleLogicalRange()?.to,id)).toBeCloseTo(7);
  return page.evaluate(id=>{
    const chart=(window as unknown as ChartHost).__liveCharts.get(id)!;
    const box=document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
    return {id,x:box.left+Number(chart.timeScale().logicalToCoordinate(0 as Logical)),
      x2:box.left+Number(chart.timeScale().logicalToCoordinate(4 as Logical)),
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

for (const [kind,label] of [['fib-extension','피보나치 확장'],['path','경로'],['callout','콜아웃'],['regression','회귀 채널']] as const) {
  test(`${label}: create, edit, duplicate, undo and reload`,async({page},info)=>{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const g=await setup(page);await choose(page,label);
    if(kind==='path') {
      await page.mouse.click(g.x,g.y);await page.mouse.click((g.x+g.x2)/2,g.y2);
      await page.mouse.move(g.x2,g.y);await page.keyboard.press('Enter');
    } else {
      await page.mouse.move(g.x,g.y);await page.mouse.down();await page.mouse.move(g.x2,g.y2,{steps:6});await page.mouse.up();
      if(kind==='fib-extension') {await expect.poll(async()=>(await read(page)).items.length).toBe(0);await page.mouse.click((g.x+g.x2)/2,g.y);}
      if(kind==='callout') {
        const editor=page.getByLabel('콜아웃 내용');await expect(editor).toBeVisible();await editor.fill('돌파 확인\n거래량 동반');await editor.press('Enter');
      }
    }
    await expect.poll(async()=>(await read(page)).items.map(d=>d.kind)).toEqual([kind]);
    await expect(page.getByTestId('drawing-property-panel')).toBeVisible();
    if(kind==='path') {
      const d=(await read(page)).items[0] as Extract<Drawing,{kind:'path'}>;expect(d.points).toHaveLength(2);
      await page.mouse.move((g.x+g.x2)/2,g.y2);await page.mouse.down();await page.mouse.move((g.x+g.x2)/2,g.y2-20,{steps:4});await page.mouse.up();
      await expect.poll(async()=>((await read(page)).items[0] as typeof d).points[1].price).not.toBe(d.points[1].price);
    }
    if(kind==='regression') {
      const end=await page.evaluate(id=>{
        const chart=(window as unknown as ChartHost).__liveCharts.get(id)!;
        const series=chart.panes()[0].getSeries().find(s=>s.seriesType()==='Candlestick')!;
        const box=document.querySelector('[data-drawing-overlay]')!.getBoundingClientRect();
        return {x:box.left+Number(chart.timeScale().logicalToCoordinate(4 as Logical)),x2:box.left+Number(chart.timeScale().logicalToCoordinate(3 as Logical)),y:box.top+Number(series.priceToCoordinate(35178))};
      },g.id);
      await page.mouse.move(end.x,end.y);await page.mouse.down();await page.mouse.move(end.x2,end.y,{steps:4});await page.mouse.up();
      await expect.poll(async()=>((await read(page)).items[0] as Extract<Drawing,{kind:'regression'}>).b.realMs).toBe(1779840180000);
    }
    if(kind==='callout') {
      const d=(await read(page)).items[0] as Extract<Drawing,{kind:'callout'}>;
      await page.mouse.move(g.x2+12,g.y2+10);await page.mouse.down();await page.mouse.move(g.x2+45,g.y2+30,{steps:4});await page.mouse.up();
      await expect.poll(async()=>((await read(page)).items[0] as typeof d).offsetX).not.toBe(d.offsetX);
      expect(((await read(page)).items[0] as typeof d).a).toEqual(d.a);
    }
    await page.getByRole('button',{name:'그리기 세부 설정'}).click();
    await page.getByLabel('그리기 이름').fill(`${label} 검증`);
    await page.getByRole('button',{name:'이름 · 좌표 적용'}).click();
    if(kind==='fib-extension') {await page.getByLabel('우측 연장',{exact:true}).uncheck();await page.getByLabel('2.618',{exact:true}).uncheck();}
    if(kind==='path') {await page.getByRole('button',{name:'점 추가',exact:true}).click();await expect(page.getByLabel('점 3 가격',{exact:true})).toBeVisible();await page.getByRole('button',{name:'점 2 삭제',exact:true}).click();await page.getByLabel('시작 화살표',{exact:true}).check();}
    if(kind==='callout') {await page.getByLabel('콜아웃 글자 크기').selectOption('20');await page.getByLabel('콜아웃 메모').fill('수정한 메모\n지지 확인');await page.getByRole('button',{name:'이름 · 좌표 적용'}).click();}
    if(kind==='regression') {await page.getByLabel('회귀 기준가').selectOption('hlc3');await page.getByLabel('상단 표준편차').fill('1.5');await page.getByLabel('하단 표준편차').click();await page.getByLabel('우측 연장',{exact:true}).check();}
    await page.screenshot({path:info.outputPath(`${kind}-settings.png`)});
    await page.getByRole('button',{name:'그리기 세부 설정'}).click();
    // Focus the chart before using shortcuts after form editing.
    await page.keyboard.press('Control+d');await expect.poll(async()=>(await read(page)).items.length).toBe(2);
    await page.keyboard.press('Control+z');await expect.poll(async()=>(await read(page)).items.length).toBe(1);
    const saved=(await read(page)).items;
    await expect.poll(()=>page.evaluate(({scope,saved})=>JSON.parse(localStorage.getItem(`replay.drawings.v2.${scope}`)||'null')?.items?.[0]?.name===saved[0].name,{scope,saved})).toBe(true);
    await page.reload();await expect.poll(async()=>(await read(page)).items).toEqual(saved);
    expect(errors).toEqual([]);
  });
}

test('path double click, Escape and right click cancel without stray vertices',async({page})=>{
  const g=await setup(page);await choose(page,'경로');await page.mouse.click(g.x,g.y);await page.mouse.dblclick(g.x2,g.y2);
  await expect.poll(async()=>(await read(page)).items.length).toBe(1);
  expect(((await read(page)).items[0] as Extract<Drawing,{kind:'path'}>).points).toHaveLength(2);
  for(const cancel of ['Escape','right'] as const) {
    await choose(page,'경로');await page.mouse.click(g.x,g.y);await page.mouse.click(g.x2,g.y2);
    if(cancel==='Escape')await page.keyboard.press('Escape');else await page.mouse.click(g.x2,g.y2,{button:'right'});
    await expect.poll(async()=>(await read(page)).items.length).toBe(1);
  }
});
