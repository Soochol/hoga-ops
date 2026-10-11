"""Application display-reference limits, separate from vendor registration slots."""

MAX_DISPLAY_CODES = 512
MAX_DISPLAY_REFS_PER_CODE = 64


class ViewSubscriptionLimitError(RuntimeError):
    """A bounded application reference ledger cannot admit another view."""
