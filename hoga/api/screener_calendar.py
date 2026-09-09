"""Shared screener policy for completed daily observations."""
import datetime as dt

from hoga.util.timeenc import KST

# Regular close (15:30) plus the existing after-hours confirmation buffer.
EOD_CUTOFF_HOUR = 16


def completed_day() -> dt.date:
    now = dt.datetime.now(KST)
    return now.date() if now.hour >= EOD_CUTOFF_HOUR else now.date() - dt.timedelta(days=1)
