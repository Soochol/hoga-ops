"""Architecture guards for the Watchlist display projection Module."""
from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _module(path: str) -> ast.Module:
    return ast.parse((ROOT / path).read_text(encoding="utf-8"))


def _function(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"function {name} not found")


def _calls(node: ast.AST, name: str) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            func = child.func
            if isinstance(func, ast.Name) and func.id == name:
                return True
            if isinstance(func, ast.Attribute) and func.attr == name:
                return True
    return False


def _constructs(node: ast.AST, name: str) -> bool:
    return _calls(node, name)


def test_live_coverage_imports_watchlist_order_instead_of_defining_it():
    """coverage.py must delegate watchlist ordering to the projection SSOT, not redefine it.

    ADR-0118 PR-G: KIS live-set(display_ordered_codes 소비) 삭제 후 coverage는
    capture 순서(capture_ordered_codes)만 쓴다 — 여전히 watchlist_projection에서 임포트한다."""
    tree = _module("hoga/live/coverage.py")

    assert not any(
        isinstance(node, ast.FunctionDef)
        and node.name in {"display_ordered_codes", "capture_ordered_codes"}
        for node in tree.body
    )
    assert any(
        isinstance(node, ast.ImportFrom)
        and node.module == "hoga.api.watchlist_projection"
        and any(alias.name == "capture_ordered_codes" for alias in node.names)
        for node in tree.body
    )


def test_watchlist_route_projection_delegates_to_domain_projection_module():
    tree = _module("hoga/api/watchlist_routes.py")
    project = _function(tree, "_project")

    assert _calls(project, "project_watchlist_response")
    assert not _constructs(project, "WatchlistEntryView")
    assert not _constructs(project, "WatchlistResponse")


def test_heatmap_seed_uses_watchlist_projection_for_first_membership():
    tree = _module("hoga/api/heatmap.py")
    seed = _function(tree, "seed_from_watchlist_if_absent")

    assert _calls(seed, "ordered_folders")
    assert _calls(seed, "first_membership_positions")
