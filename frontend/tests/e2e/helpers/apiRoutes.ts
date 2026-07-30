/**
 * `page.route()` 용 API URL 매처 — **호스트 루트에 앵커된 정규식**.
 *
 * 이 저장소에서 glob 은 두 번 물렸다.
 *
 * 1. `'http://localhost:8080/api/…'` 처럼 호스트를 박아 두면, 그 값이 사실은 API 주소가
 *    아니라 `config.ts` 의 `DEFAULT_CONFIG` **폴백**이라 "설정 로드 실패" 라는 사고
 *    상태에서만 맞았다. e2e 가 실제로 돌기 시작해 `/config.json` 이 정상 제공되자
 *    모킹이 한 건도 안 걸렸다.
 * 2. 그렇다고 `'**\/api/…'` 로 완화하면 **자기 소스 파일을 가로챈다**. Playwright 의
 *    `**` 는 `/` 를 포함해 매칭하므로 `**\/api/symbols*` 가 vite 가 서빙하는
 *    `/src/api/symbols.ts` 에도 걸린다 — 그 모듈이 JSON 으로 대체되면서
 *    "Failed to load module script: … MIME type of application/json" 으로 앱이 통째로
 *    빈 화면이 됐다(실측). 이 저장소는 프론트 소스에 `src/api/` 가 있어서 API 경로와
 *    소스 경로가 문자열로 겹친다 — 충돌 5건: watchlist · symbols · calendar · range ·
 *    captures.
 *
 * 그래서 `/api/…` 가 **경로 맨 앞**일 때만 매칭한다. `/src/api/…` 는 걸리지 않고,
 * 포트가 바뀌어도 그대로 동작한다.
 */

const ORIGIN = String.raw`^https?://[^/]+`;

/** `/api/<path>` 로 **시작**하는 모든 URL. glob 의 `…*` 자리. */
export function apiPrefix(path: string): RegExp {
  return new RegExp(`${ORIGIN}/api/${path}`);
}

/** `/api/<path>` **정확히**(쿼리스트링만 허용).
 *
 *  접두사와 구분하는 게 중요하다 — `/api/watchlist` 를 접두사로 두면
 *  `/api/watchlist/reorder` 까지 잡고, Playwright 는 **나중에 등록된 라우트가 이기므로**
 *  더 구체적인 reorder 모킹이 조용히 무력화된다. */
export function apiExact(path: string): RegExp {
  return new RegExp(`${ORIGIN}/api/${path}(?:\\?[^#]*)?$`);
}
