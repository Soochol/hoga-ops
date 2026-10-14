


/**
 * 이 오류가 "배포로 청크가 갈렸다" 인가.
 *
 * 서버에 새 빌드가 올라가면 옛 해시 청크는 삭제된다. 그 전에 열어 둔 탭이 아직
 * 방문하지 않은 lazy 표면(드로어·설정·라우트)을 처음 열면 `import()` 가 404 로
 * 죽는다 — 며칠씩 탭을 열어 두는 이 앱에서는 배포마다 일어나는 일이다.
 *
 * 이걸 일반 렌더 오류와 갈라야 하는 이유는 **복구 수단이 정반대**이기 때문이다.
 * 다시 시도(re-mount)는 같은 URL 을 다시 부르므로 반드시 또 404 다 — 사용자에게는
 * 눌리지 않는 죽은 버튼으로 보인다. 여기서 유효한 유일한 조치는 새로고침(새
 * index.html 을 받아 새 해시를 알게 된다)이다.
 *
 * 브라우저마다 문구가 달라 셋 다 본다(크롬/파이어폭스/사파리). 문자열 매칭이
 * 거슬리지만 이 실패에는 구조화된 타입이 없다 — 못 잡으면 종전 화면으로
 * 떨어질 뿐이라 실패 모드가 안전하다.
 */
export function isStaleChunkError(error: Error): boolean {
  const msg = `${error.name}: ${error.message}`.toLowerCase();
  return (
    msg.includes('dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('failed to fetch dynamically imported')
  );
}
