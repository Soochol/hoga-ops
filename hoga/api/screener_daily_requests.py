"""Identity for sharing in-flight daily pages, never independent confirmation rounds."""


def page_key(fetch_fn, fallback, *, observation="initial"):
    identity = getattr(fetch_fn, "request_identity", None)
    return ("screener-daily-page-v1", identity, observation) if identity is not None else fallback
