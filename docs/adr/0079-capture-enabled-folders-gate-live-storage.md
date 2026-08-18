# Capture-enabled folders gate live storage

Status: **superseded by ADR-0150** (2026-08-18) — 폴더 단위 저장 옵트인은 제거됐다.
옵트인이 지키려던 용량은 히트맵(게이트 없음)이 대부분을 쓰고 있어 지켜지지 않았고,
신규 폴더 기본 꺼짐 + 발견하기 어려운 UI 때문에 사용자의 관심종목 43종목이 전부
저장 제외인 상태가 방치됐다(실측). 아래는 당시 결정의 기록이다.

The Watchlist remains the user's organised list of Codes, but live KIS storage is now gated by folder-level `capture_enabled`: only Codes in capture-enabled folders become Capture Candidates. The old model treated the whole Watchlist as the Live Set input, but that made the new REST 30s storage mode ambiguous: users expected "checked groups" to control whether data is stored at all. The chosen model makes the rule explicit: group opt-in decides *whether* a Code is saved, and Storage Policy decides *how* it is saved (`kis_live`, `kis_api`, or both).

Consequences: existing folders migrate as capture-enabled to preserve current capture behavior; new folders default to disabled so live storage remains an explicit opt-in. The internal WS source id stays `kis_live`; "KIS WS" is a UI label, not an on-disk/source-id migration.
