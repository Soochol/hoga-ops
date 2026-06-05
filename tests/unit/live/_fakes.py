"""Shared test doubles for KIS live tests."""


class FakeTokenProvider:
    """Minimal sync provider stub — fetch paths don't exercise issuance,
    so a constant token is sufficient. Mirrors KisTokenProvider's interface."""

    def __init__(self, token: str = "MOCK_TOKEN") -> None:
        self._token = token

    def get_token(self) -> str:
        return self._token

    def close(self) -> None:
        pass
