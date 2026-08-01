# 0134 — prod 배포: Tailscale 단일 origin, ADR-0036 전제의 개정

**Status:** accepted (2026-08-02)

**Related:**
- ADR-0036 — "로컬 단일 사용자·리소스 캡 없음". 이 ADR 이 그 보안 경계를 루프백에서
  tailnet 으로 옮긴다. 무인증·무캡 결론 자체는 유지된다 — 근거가 "루프백만 도달
  가능"에서 "tailnet 초대 = 전적 신뢰"로 바뀔 뿐이다.
- 온프레미스 감사(2026-08-01, 지도 #985 첫 댓글) — 이 결정의 발견 전부(3중 벽,
  인증 0 + 상태변경 51개, origin 하드코딩)가 거기서 나왔다.
- 지도 #985 · 결정 티켓 #986(노출·접근 정책) · #987(프론트 서빙 방식) — 그릴링
  전문과 기각 사유가 티켓 해소 댓글에 있다.

## Context

hoga-ops 를 dev(개발 PC)/prod(별도 상시 서버) 로 나누고, 지인 ~5명이 **외부
인터넷에서** prod 에 접속하게 한다. 감사 결과 현행 코드는 로컬 단일 사용자 전제가
세 층에 복제되어 있었다: `hoga serve` 의 루프백 하드코딩, `config.json` 의
`localhost:8000` 절대 URL, CORS·OriginGuard 의 localhost whitelist. 그리고 인증이
없으므로 포트에 닿는 누구나 파괴적 엔드포인트(cancel-all 등 — 장중이면 오전분 영구
소실)를 호출할 수 있다.

## Decision

**1. 네트워크 경계 = Tailscale tailnet.** 공개 인터넷 노출 0(도메인·TLS·포트포워딩·
리버스 프록시 전부 불필요). 지인은 기기 공유 초대로 참여한다. 서버는 tailscale
인터페이스 주소에만 바인드한다(`hoga serve --host <tailscale-ip>` — `--host` 는 이
ADR 로 신설, 기본값은 여전히 루프백). 공인·LAN 인터페이스 바인드는 금지 유지.

**2. 신뢰 모델 = 전원 전체 허용.** 읽기전용 분리·프록시 인증·앱 내 토큰은 전부
기각(사용자 확정, #986). tailnet 초대가 곧 전권 부여다. cancel-all 류 사고와
관심종목 last-writer-wins 덮어쓰기는 **감수하기로 확정**한 위험이다.

**3. 주소 = `http://<MagicDNS 이름>:8000` 단일 origin, 영구 고정.** 화면 상태
(그리기·창 배치·지표 설정)가 브라우저의 origin 단위 저장이라 주소 변경 = 전원
상태 초기화다. 그래서 origin 의 세 요소를 전부 못 박는다 — HTTP(tailnet 이
WireGuard 암호화라 실질 동등; secure-context 전용 API 미사용 실측), MagicDNS
이름(기기 교체에도 유지), :8000(비특권 포트 — :80 은 setcap/sysctl 의존이라 기각).
집 LAN 주소 병용도 기각 — origin 이원화가 상태를 두 벌로 가른다.

**4. 프론트 서빙 = FastAPI 직접(StaticFiles + SPA fallback), env opt-in.**
`HOGA_FRONTEND_DIST` 가 있을 때만 활성 — dev(vite 5173) 습관 불변. 정적 서버
추가는 기각(5명 규모에서 성능 근거 없음). 폰트는 self-host 로 전환해 유일한 외부
런타임 의존(jsdelivr, 렌더 블로킹)을 제거한다. 구현은 #993.

**5. 배포 origin 허용 = `HOGA_ALLOWED_ORIGINS` env 명시. same-origin 추론은
기각.** Sec-Fetch-Site: same-origin 우선 인정(감사 개선안)이나 Origin==Host 비교는
**DNS rebinding 에 뚫린다**: 공격자 도메인을 서버 IP 로 rebind 하고 그 도메인:포트
에서 페이지를 서빙하면, 이후 요청은 rebound 호스트 기준으로 진짜 same-origin 이라
두 신호가 모두 통과한다. 현행 "Origin 값 우선 whitelist 대조"가 우연이 아니라
**유일하게 rebinding 을 구분하는 판정**이므로 유지하고, same-origin 배포는 자기
origin 을 env 로 목록에 넣는 방식으로 해결한다(허용 목록은 CORS 와 OriginGuard 가
create_app 의 단일 호출 결과를 공유).

## Consequences

- prod 구성은 `.env` 두 줄(`HOGA_ALLOWED_ORIGINS`, 이후 `HOGA_FRONTEND_DIST`) +
  `--host` 인자로 끝난다. 코드에 tailscale 의존은 없다 — tailscale 이 없어도
  루프백 dev 는 종전과 동일.
- 인증 부재 위에 기능을 계속 쌓아도 된다 — 단 그 전제는 "tailnet 밖에서는 포트에
  닿을 수 없다"다. 이 전제를 깨는 배포(공개 바인드)는 이 ADR 의 스코프 밖이며,
  그때는 인증 논의를 처음부터 다시 해야 한다.
- 브라우저 귀속 화면 상태의 잔여 리스크(PC 교체·브라우저 데이터 삭제)는 주소
  고정으로도 남는다 — 별도 결정(#992)으로 다룬다.
- 감사의 DNS rebinding 읽기 노출(low)은 tailnet 화로 표면이 줄지만 원리상 남는다
  (tailnet 멤버 브라우저 경유). 쓰기는 5번 결정이 막는다.
