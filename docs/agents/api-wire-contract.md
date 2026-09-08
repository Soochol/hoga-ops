# API wire 계약 변경

라우트·응답 모델·enum·JSONResponse 또는 계약 검사를 변경할 때 읽는다.
[ADR-0004](../adr/0004-wire-model-no-adapter.md)가 계약의 기준이다.
백엔드 wire 모델과 프론트 타입은 손으로 미러하며, codegen으로 대체하지 않는다.

## 계약 검사

[test_rest_wire_schema_contract.py](../../tests/unit/api/test_rest_wire_schema_contract.py)가
다음 네 가지를 검사한다. 등록 위치와 현재 예외는 이 파일이 기준이다.

| 변경 | 함께 확인할 등록 |
|---|---|
| 응답 필드 | `EXPECTED_REST_WIRE_FIELDS`와 모듈 밖 모델의 별도 표 |
| BE Literal / FE union 값 | `WIRE_ENUM_MIRRORS` |
| 라우트의 반환형 | wire 모델 없는 라우트 검사; 빈 동결선을 유지 |
| 직접 생성한 JSONResponse | `JSON_RESPONSE_ROUTES` |

## 라우트·응답 모델

1. 새 JSON 라우트는 Pydantic 반환 모델을 선언한다. 모델 없는 `dict` 반환을
   허용 목록에 추가해 검사를 우회하지 않는다. 파일·스트림·204는 Response 계열을 쓴다.
2. JSONResponse가 필요하면 body를 모델로 만들거나 모델로 검증하고,
   `JSON_RESPONSE_ROUTES`에 사용 모델을 등록한다.
3. 생산 함수의 필드를 전수로 읽고 `frontend/src/api/`의 소비 타입과 대조한다.
   FastAPI는 모델에 선언되지 않은 필드를 에러 없이 제거할 수 있다.
4. 동적 shape가 계약인 `Record<string, unknown>`을 임의로 좁히지 않는다.
   `/api/live/series`처럼 `extra="allow"`가 필요한 경로를 보존한다.
5. 키 부재와 null을 구별한다. 원래 키를 생략하는 계약에만
   `response_model_exclude_none=True`를 사용한다. 예를 들어 `days_behind: null`을
   없애면 소비자가 읽는 의미가 달라진다.
6. `from_ = Field(alias="from")` 같은 wire alias를 보존하고 출력 키를 검사한다.

## enum과 검사 자체의 변경

- BE `Literal`과 FE union을 같은 PR에서 수정한다. 이름이 다르거나 필드에 인라인된
  Literal은 자동 후보 탐색에서 빠질 수 있으므로 `WIRE_ENUM_MIRRORS`에 직접 등록한다.
- 이름 규칙만으로 값 미러를 자동 등록하지 않는다. 의도적 비대칭은
  `INTENTIONALLY_UNMIRRORED`에 사유를 기록한다.
- TS union 파서를 바꿨다면 파서의 회귀 테스트도 실행한다. 파서가 값을 누락한 것을
  제품의 타입 불일치로 오인하지 않도록 실제 추출값을 확인한다.
- 가드를 바꿨다면 한쪽에 임시 불일치를 넣어 실패를 확인하고 되돌린 뒤 다시 통과시킨다.

## 완료 확인

- 엔드포인트 함수를 직접 부르는 테스트만으로 끝내지 않는다. HTTP 응답 또는 실제
  직렬화 경로에서 키·값을 확인하고, 폴백·부분 payload·빈 응답도 검증한다.
- 접근 가능한 실데이터 응답이 있으면 GET으로 읽어 `model_validate` → `model_dump` 전후의
  키를 재귀 비교한다. 무자격 폴백만으로 실데이터 필드 보존을 입증했다고 하지 않는다.
  검증용 서버에 실자격증명을 복사하거나 새 토큰을 발급하는 방식은 쓰지 않는다.
- wire 계약 검사와 변경 경로의 테스트를 통과시키고, 임시 불일치를 모두 제거한다.
