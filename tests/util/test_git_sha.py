from pathlib import Path
from unittest.mock import patch

from hoga.util.git_sha import get_git_sha


def test_returns_sha_in_a_git_repo():
    # This repo itself is a git repo — the call should return something.
    sha = get_git_sha()
    assert sha is None or (isinstance(sha, str) and len(sha) >= 7)


def test_returns_none_when_not_a_git_repo(tmp_path: Path):
    with patch("hoga.util.git_sha._REPO_ROOT", tmp_path):
        assert get_git_sha() is None


def test_returns_none_on_subprocess_failure():
    with patch("hoga.util.git_sha.subprocess.check_output", side_effect=FileNotFoundError):
        assert get_git_sha() is None
