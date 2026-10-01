import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('legend fallback reads native cursor and latest values without copying series', async ({page}) => {
  await installLiveMocks(page);
  await page.goto('/live?code=098460');
  const result = await page.evaluate(async () => {
    const libraryPath = '/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs';
    const readerPath = '/src/live/legendRows.ts';
    const {createChart,LineSeries} = await import(libraryPath);
    const {readSeriesValue} = await import(readerPath);
    const container = document.createElement('div');
    container.style.cssText='width:800px;height:400px';document.body.append(container);
    const chart=createChart(container,{width:800,height:400});
    try {
      let copies=0, points=0;
      const t=Date.parse('2026-09-30T09:00:00+09:00')/1000;
      const data=Array.from({length:10000},(_,i)=>({time:t+i,value:100+i%7}));
      const series=Array.from({length:8},()=>{const s=chart.addSeries(LineSeries);s.setData(data);
        const original=s.data.bind(s);s.data=()=>{const rows=original();copies++;points+=rows.length;return rows;};return s;});
      let correct = true;
      for(let i=0;i<60;i++) for(const s of series) {
        const logical = chart.timeScale().timeToIndex(t+i);
        correct &&= readSeriesValue(s,null,t+i,logical) === 100+i%7;
        correct &&= readSeriesValue(s,null) === 100+9999%7;
      }
      const fallback={copies,points};copies=0;points=0;
      for(let i=0;i<60;i++) for(const s of series) readSeriesValue(s,new Map([[s,{time:t+i,value:100+i%7}]]),t+i);
      return {series:8,loadedPoints:10000,moves:60,correct,fallback,nativeCursor:{copies,points}};
    } finally {chart.remove();container.remove();}
  });
  expect(result.fallback).toEqual({copies:0,points:0});
  expect(result.nativeCursor).toEqual({copies:0,points:0});
  expect(result.correct).toBe(true);
});
