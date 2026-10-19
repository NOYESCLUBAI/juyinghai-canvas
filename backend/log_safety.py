"""Redact credentials and media payloads before they reach any log handler."""
from __future__ import annotations

import logging
import re

_BEARER = re.compile(r'(?i)(bearer\s+)[A-Za-z0-9._\-+/=]+')
_KEY_FIELD = re.compile(r'(?i)(api[_-]?key|authorization|service_role|jwt)(["\']?\s*[:=]\s*["\']?)[^"\'\s,}&]+')
_DATA_URL = re.compile(r'data:(?:image|video|application)/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+')
_QUERY_SECRET = re.compile(r'(?i)(token|sig|apikey|api_key|access_token)=([^&\s]+)')


def redact(value: str) -> str:
    value = _DATA_URL.sub('data:[redacted]', value)
    value = _BEARER.sub(r'\1[redacted]', value)
    value = _KEY_FIELD.sub(r'\1[redacted]', value)
    value = _QUERY_SECRET.sub(r'\1=[redacted]', value)
    return value


class SecretRedactor(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        args = record.args
        if isinstance(args, dict):
            record.args = {key: redact(item) if isinstance(item, str) else item for key, item in args.items()}
        elif isinstance(args, tuple):
            record.args = tuple(redact(item) if isinstance(item, str) else item for item in args)
        return True


def install_log_redaction() -> None:
    redactor = SecretRedactor()
    loggers = [logging.getLogger()]
    loggers.extend(logging.getLogger(name) for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access', 'httpx', 'httpcore'))
    for logger in loggers:
        if not any(isinstance(item, SecretRedactor) for item in logger.filters):
            logger.addFilter(redactor)
