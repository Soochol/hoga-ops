"""Application display-reference limits, separate from vendor registration slots."""

from typing import Literal

from pydantic import BaseModel

ViewSubscriptionPhase = Literal["waiting_connection", "waiting_slot", "registering", "registered"]


class ViewSubscriptionStatus(BaseModel):
    """One active display reference, observed in the current collector generation."""

    code: str
    venue: str
    phase: ViewSubscriptionPhase
    connection_generation: int | None = None


MAX_DISPLAY_CODES = 512
MAX_DISPLAY_REFS_PER_CODE = 64


class ViewSubscriptionLimitError(RuntimeError):
    """A bounded application reference ledger cannot admit another view."""
