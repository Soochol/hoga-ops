"""Paths and cookie loading."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class CookieMissingError(RuntimeError):
    """Raised when no cookie source is available."""


@dataclass(frozen=True)
class Config:
    repo_root: Path

    def cookie(self) -> str:
        env = os.environ.get("HOGAPLAY_COOKIE")
        if env:
            return env.strip()
        cookie_file = self.repo_root / ".cookie"
        if cookie_file.exists():
            return cookie_file.read_text(encoding="utf-8").strip()
        raise CookieMissingError(
            "No cookie found. Set HOGAPLAY_COOKIE env var or create .cookie file "
            "with 'k_=...; n_=...' (copy from your hogaplay browser session)."
        )

    @property
    def data_dir(self) -> Path:
        return self.repo_root / "data"

    def raw_dir(self, date: str, code: str) -> Path:
        return self.data_dir / "raw" / date / code

    def parquet_dir(self, date: str, code: str) -> Path:
        return self.data_dir / "parquet" / date / code

    @classmethod
    def from_cwd(cls) -> Config:
        return cls(repo_root=Path.cwd())
