#!/usr/bin/env python3
"""관심종목 대폭 확장 큐레이션 — 멱등 적용 스크립트.

설계: docs/superpowers/specs/2026-06-10-watchlist-expansion-design.md
데이터: scripts/watchlist_curation_data.json (선언적 목표 — renames/new_folders/folder_targets)

사용:
    # 1) 미리보기(기본) — 아무 것도 바꾸지 않고 계획만 출력
    python3 scripts/apply_watchlist_curation.py
    # 2) 실제 적용 — 백엔드(:8000)가 떠 있어야 함
    python3 scripts/apply_watchlist_curation.py --apply
    # 3) 사후조건 검증만
    python3 scripts/apply_watchlist_curation.py --verify

멱등성: 재실행해도 안전.
- 폴더 생성: 같은 이름이 이미 있으면 skip
- 종목 추가: 이미 있으면 409 → skip
- 이동(move): 이미 대상 폴더에 있는 코드는 제외(서버 move_entries도 no-op)
- 순서(reorder): 신규 폴더 멤버 == 목표 코드일 때만 호출

API 계약(hoga/api/watchlist_routes.py):
- GET    /api/watchlist                       -> {folders:[{id,name,order}], entries:[...], ...}
- POST   /api/watchlist          {code}       -> 추가(404 unknown_code / 409 already_in_watchlist)
- POST   /api/watchlist/folders  {name}       -> {id,name,order} (맨끝 append)
- PATCH  /api/watchlist/folders/{id} {name}   -> 리네임
- POST   /api/watchlist/move     {codes, folder_id}        -> 이동(대상 멤버 뒤 append)
- PUT    /api/watchlist/reorder  {folder_id, ordered_codes} -> 폴더 내 순서(전체 멤버 일치)
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

DATA_PATH = Path(__file__).with_name("watchlist_curation_data.json")
DEFAULT_BASE = "http://127.0.0.1:8000"
TIMEOUT = 15

HTTP_OK = 200
HTTP_CREATED = 201
HTTP_NO_CONTENT = 204
HTTP_NOT_FOUND = 404
HTTP_CONFLICT = 409


def _req(method: str, base: str, path: str, body: dict | None = None) -> tuple[int, object]:
    """HTTP 요청. (status, parsed_json_or_text) 반환. 4xx/5xx도 예외 없이 status로 반환."""
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def get_watchlist(base: str) -> dict:
    status, doc = _req("GET", base, "/api/watchlist")
    if status != HTTP_OK or not isinstance(doc, dict):
        sys.exit(f"[FATAL] GET /api/watchlist 실패 status={status}: {doc}")
    return doc


@dataclass
class State:
    """적용 진행 상태. name_to_id·have_codes·where는 단계 간 공유·갱신된다."""

    name_to_id: dict[str, str]
    have_codes: set[str]
    where: dict[str, str | None]      # code -> 현재 folder_id (None=미분류)
    do_apply: bool
    log: list[str] = field(default_factory=list)

    def act(self, msg: str) -> None:
        self.log.append(("APPLY " if self.do_apply else "DRY   ") + msg)


def _do_renames(base: str, data: dict, st: State) -> int:
    n = 0
    for r in data["renames"]:
        src, dst = r["from"], r["to"]
        if dst in st.name_to_id:                       # 이미 리네임됨 → skip
            continue
        fid = st.name_to_id.get(src)
        if fid is None:
            st.log.append(f"WARN  리네임 원본 폴더 없음: '{src}' (이미 처리?)")
            continue
        st.act(f"리네임 '{src}' -> '{dst}'")
        n += 1
        if st.do_apply:
            code, b = _req("PATCH", base, f"/api/watchlist/folders/{fid}", {"name": dst})
            if code != HTTP_NO_CONTENT:
                sys.exit(f"[FATAL] 리네임 실패 {src}->{dst} status={code}: {b}")
        st.name_to_id[dst] = fid
        st.name_to_id.pop(src, None)
    return n


def _do_creates(base: str, data: dict, st: State) -> int:
    n = 0
    for name in data["new_folders"]:                   # 생성 순서 유지(레버리지/인버스 마지막)
        if name in st.name_to_id:                      # 이미 있음 → skip
            continue
        st.act(f"폴더 생성 '{name}'")
        n += 1
        if st.do_apply:
            code, b = _req("POST", base, "/api/watchlist/folders", {"name": name})
            if code != HTTP_CREATED or not isinstance(b, dict):
                sys.exit(f"[FATAL] 폴더 생성 실패 '{name}' status={code}: {b}")
            st.name_to_id[name] = b["id"]
        else:
            st.name_to_id[name] = f"<dry:{name}>"
    return n


def _collect_new_codes(data: dict, st: State) -> list[tuple[str, str]]:
    new_codes: list[tuple[str, str]] = []
    seen: set[str] = set()
    for ft in data["folder_targets"]:
        for code, nm in ft["codes"]:
            if code in seen or code in st.have_codes:
                seen.add(code)
                continue
            seen.add(code)
            new_codes.append((code, nm))
    return new_codes


def _do_adds(base: str, data: dict, st: State) -> tuple[int, int]:
    added = skipped = 0
    for code, nm in _collect_new_codes(data, st):
        if st.do_apply:
            status, b = _req("POST", base, "/api/watchlist", {"code": code})
            if status == HTTP_CREATED:
                added += 1
            elif status == HTTP_CONFLICT:
                skipped += 1
            elif status == HTTP_NOT_FOUND:
                sys.exit(f"[FATAL] symbol-master에 없는 코드 {code} {nm}: {b}")
            else:
                sys.exit(f"[FATAL] 추가 실패 {code} {nm} status={status}: {b}")
        else:
            added += 1
        st.act(f"종목 추가 {code} {nm} -> 미분류")
        st.have_codes.add(code)
        st.where[code] = None
    return added, skipped


def _do_moves(base: str, data: dict, st: State) -> int:
    n = 0
    for ft in data["folder_targets"]:
        folder = ft["folder"]
        fid = st.name_to_id.get(folder)
        if fid is None:
            sys.exit(f"[FATAL] 대상 폴더 미존재: '{folder}' (리네임/생성 누락?)")
        codes = [c for c, _ in ft["codes"] if st.where.get(c) != fid]  # 제자리는 제외(멱등)
        if not codes:
            continue
        st.act(f"이동 -> '{folder}' ({len(codes)}종목): {','.join(codes)}")
        n += 1
        if st.do_apply:
            code, b = _req("POST", base, "/api/watchlist/move",
                           {"codes": codes, "folder_id": fid})
            if code != HTTP_NO_CONTENT:
                sys.exit(f"[FATAL] move 실패 folder='{folder}' status={code}: {b}")
        for c in codes:
            st.where[c] = fid
    return n


def _do_reorders(base: str, data: dict, st: State) -> int:
    """신규 폴더 내부 순서 확정(reorder=True인 것만). 멤버 == 목표 코드여야 안전."""
    if not st.do_apply:
        return sum(1 for ft in data["folder_targets"] if ft.get("reorder"))
    doc = get_watchlist(base)
    members: dict[str | None, set[str]] = {}
    for e in doc["entries"]:
        members.setdefault(e["folder_id"], set()).add(e["code"])
    n = 0
    for ft in data["folder_targets"]:
        if not ft.get("reorder"):
            continue
        fid = st.name_to_id[ft["folder"]]
        want = [c for c, _ in ft["codes"]]
        if set(want) != members.get(fid, set()):
            st.log.append(f"WARN  reorder 건너뜀 '{ft['folder']}': 멤버 불일치 — 수동 확인")
            continue
        code, b = _req("PUT", base, "/api/watchlist/reorder",
                       {"folder_id": fid, "ordered_codes": want})
        if code != HTTP_NO_CONTENT:
            sys.exit(f"[FATAL] reorder 실패 '{ft['folder']}' status={code}: {b}")
        n += 1
    return n


def _print_final(base: str) -> None:
    final = get_watchlist(base)
    fmap = {f["id"]: f["name"] for f in final["folders"]}
    cnt = Counter(fmap.get(e["folder_id"], "미분류") for e in final["entries"])
    print(f"\n  최종: {len(final['folders'])}폴더 / {len(final['entries'])}종목")
    for f in sorted(final["folders"], key=lambda x: x["order"]):
        print(f"    {cnt.get(f['name'], 0):2d}  {f['name']}")
    unfiled = sum(1 for e in final["entries"] if e["folder_id"] is None)
    if unfiled:
        print(f"    ⚠ 미분류 {unfiled}종목 — 배치 누락 확인")


def apply(base: str, do_apply: bool) -> None:
    data = json.loads(DATA_PATH.read_text())
    doc = get_watchlist(base)
    st = State(
        name_to_id={f["name"]: f["id"] for f in doc["folders"]},
        have_codes={e["code"] for e in doc["entries"]},
        where={e["code"]: e["folder_id"] for e in doc["entries"]},
        do_apply=do_apply,
    )
    n_rename = _do_renames(base, data, st)
    n_create = _do_creates(base, data, st)
    n_add, n_skip = _do_adds(base, data, st)
    n_move = _do_moves(base, data, st)
    n_reorder = _do_reorders(base, data, st)

    print("\n".join(st.log))
    print("\n" + "=" * 60)
    mode = "적용 완료" if do_apply else "미리보기(DRY-RUN) — --apply 로 실제 반영"
    print(f"[{mode}]")
    print(f"  리네임 {n_rename} · 폴더생성 {n_create} · 종목추가 {n_add}"
          f"(skip {n_skip}) · move {n_move} · reorder {n_reorder}")
    if do_apply:
        _print_final(base)


def _verify_targets(data: dict, name_to_id: dict, code_to_fid: dict) -> list[str]:
    fails: list[str] = []
    for ft in data["folder_targets"]:
        fid = name_to_id.get(ft["folder"])
        if fid is None:
            fails.append(f"폴더 없음: '{ft['folder']}'")
            continue
        for code, nm in ft["codes"]:
            actual = code_to_fid.get(code, "<없음>")
            if actual == "<없음>":
                fails.append(f"종목 누락: {code} {nm} (목표 '{ft['folder']}')")
            elif actual != fid:
                fails.append(f"배치 오류: {code} {nm} -> 목표 '{ft['folder']}' 아님")
    return fails


def verify(base: str) -> None:
    """적용 후 사후조건 검증(결정적). 실패 시 exit 1."""
    data = json.loads(DATA_PATH.read_text())
    doc = get_watchlist(base)
    name_to_id = {f["name"]: f["id"] for f in doc["folders"]}
    code_to_fid = {e["code"]: e["folder_id"] for e in doc["entries"]}

    fails: list[str] = []
    for r in data["renames"]:
        if r["from"] in name_to_id:
            fails.append(f"리네임 미적용: '{r['from']}' 아직 존재")
        if r["to"] not in name_to_id:
            fails.append(f"리네임 대상 없음: '{r['to']}'")
    fails += [f"신규 폴더 없음: '{n}'" for n in data["new_folders"] if n not in name_to_id]
    fails += _verify_targets(data, name_to_id, code_to_fid)
    unfiled = [e["code"] for e in doc["entries"] if e["folder_id"] is None]
    if unfiled:
        fails.append(f"미분류 잔여 {len(unfiled)}종목: {unfiled}")

    # 최종 카운트 단언 — 의도치 않은 부수 변경(예상 외 추가/삭제) 탐지
    exp_f, exp_e = data.get("expected_folders"), data.get("expected_entries")
    if exp_f is not None and len(doc["folders"]) != exp_f:
        fails.append(f"폴더 수 불일치: {len(doc['folders'])} != 기대 {exp_f}")
    if exp_e is not None and len(doc["entries"]) != exp_e:
        fails.append(f"종목 수 불일치: {len(doc['entries'])} != 기대 {exp_e}")

    print(f"검증: {len(doc['folders'])}폴더 / {len(doc['entries'])}종목"
          + (f" (기대 {exp_f}/{exp_e})" if exp_f else ""))
    if fails:
        print(f"[FAIL] {len(fails)}건:")
        for f in fails:
            print("  ✘ " + f)
        sys.exit(1)
    print("[PASS] 모든 리네임·신규폴더·종목배치 사후조건 충족, 미분류 0")


def main() -> None:
    ap = argparse.ArgumentParser(description="관심종목 큐레이션 멱등 적용")
    ap.add_argument("--apply", action="store_true", help="실제 적용(미지정 시 dry-run)")
    ap.add_argument("--verify", action="store_true", help="적용 후 사후조건 검증만 수행")
    ap.add_argument("--base", default=DEFAULT_BASE, help=f"백엔드 URL (기본 {DEFAULT_BASE})")
    args = ap.parse_args()
    if not DATA_PATH.exists():
        sys.exit(f"[FATAL] 데이터 파일 없음: {DATA_PATH}")
    if args.verify:
        verify(args.base)
    else:
        apply(args.base, args.apply)


if __name__ == "__main__":
    main()
