"""Shared test doubles for KIS live tests."""


class FakeTokenProvider:
    """Minimal sync provider stub — fetch paths don't exercise issuance,
    so a constant token is sufficient. Mirrors KisTokenProvider's interface.
    ``invalidated`` counts invalidate() calls so tests can assert the
    token-invalid retry path in KisClient._get."""

    def __init__(self, token: str = "MOCK_TOKEN") -> None:
        self._token = token
        self.invalidated = 0

    def get_token(self) -> str:
        return self._token

    def invalidate(self) -> None:
        self.invalidated += 1

    def close(self) -> None:
        pass
