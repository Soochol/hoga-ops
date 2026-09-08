# 차트 배율·초기 화면 진단

Live 차트의 초기 줌, 봉 위치, 몸통 두께, 로딩 중 화면 이동을 조사할 때 읽는다.
창 간 동기화나 겹친 창에 입력을 보낼 때는 [chart-sync-qa.md](chart-sync-qa.md)도 읽는다.

## 먼저 숫자를 기록한다

`/browse`에서 문제가 나는 origin과 화면을 연 뒤 창별 차트 값을 읽는다.
단일 `window.__liveChart`는 마지막 생성 차트이므로 대상 창을 보장하지 않는다.

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B js '(() => {
  const workspace = JSON.parse(sessionStorage.getItem("live.workspace.v1")
    || localStorage.getItem("live.workspace.v1") || "{}");
  return {
    href: location.href, dpr: devicePixelRatio, zoom: visualViewport?.scale,
    charts: Array.from(window.__liveCharts || [], ([id, chart]) => {
      const win = workspace.windows?.find(w => w.id === id);
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      const series = chart.panes().flatMap(p => p.getSeries())
        .find(s => s.seriesType() === "Candlestick");
      const candles = series?.data().filter(p => typeof p.close === "number") || [];
      const last = candles.at(-1);
      return {
        id, timeframe: win?.chart?.timeframe,
        subject: win?.pinned ?? workspace.groupSymbols?.[win?.group],
        count: candles.length, range, span: range && range.to - range.from,
        width: ts.width(), options: ts.options(),
        latestX: last ? ts.timeToCoordinate(last.time) : null,
      };
    }),
  };
})()'
$B screenshot /tmp/live-viewport.png
```

`__liveCharts`는 dev 빌드의 진단용 핸들이다. 없으면 dev 빌드 여부부터 확인한다.
결과의 창 id·종목·봉 주기가 조사 대상과 같은지 확인한 뒤 비교한다.

## 증상별 확인

- **일봉 몸통이 가늘 때**: 폭 대비 표시 범위, `barSpacing`, `minBarSpacing`,
  `rightOffset`, 데이터 개수, 브라우저 배율을 함께 확인한다. D/W/M은 전체 데이터
  `fitContent()` 대신 읽을 수 있는 범위로 배치하는 정책이다. 배율 변경은 D/W/M을 함께 검증한다.
- **분봉 첫 화면이 확대될 때**: 오늘 seed만 도착한 시점과 과거 병합 후를 각각 잰다.
  오늘 첫 몇 봉에 맞춰 범위를 축소하면 과거 봉이 나중에 와도 줌이 남는다.
  초기 과거 수집 중에는 기존 300봉 기준 범위와 최신 봉의 위치가 유지돼야 한다(#1769).
- **과거 추가 중 화면이 움직일 때**: 논리 인덱스는 prepend에 따라 달라질 수 있다.
  표시 시각·봉 간격·최신 봉의 픽셀 위치를 대조하고, 사용자의 팬·줌을 초기화하지 않는지 확인한다.

브라우저끼리 다르면 같은 origin·종목·봉 주기·창 크기·지표 설정을 맞춘다.
별도 프로필로 비교할 수 있지만 원래 브라우저의 저장소 전체를 지우지 않는다.
저장 상태가 원인으로 확인되면 해당 키를 백업하고 필요한 범위만 다룬다.
특정 라우트의 React 오류는 [Vite 진단](local-development.md)도 확인한다.

수정 후 `frontend/`에서 `npx vitest run src/live/LiveChartRoot.test.tsx`와
`npm run build`를 실행하고, 실제 브라우저에서 원래 종목 선택·로딩 순서로 재검증한다.
