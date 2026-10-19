"""Fixed-window limits keyed by both user and client IP."""
from __future__ import annotations

import os
import time
from collections import defaultdict

from fastapi import HTTPException


class RateLimiter:
    def __init__(self) -> None:
        self.events: dict[tuple[str, str], list[float]] = defaultdict(list)

    def reset(self) -> None:
        self.events.clear()

    def hit(self, user_id: str, ip: str, kind: str, *, limit: int, window_seconds: float = 60) -> None:
        now = time.monotonic()
        for subject in (f'user:{user_id}', f'ip:{ip}'):
            key = (subject, kind)
            bucket = [stamp for stamp in self.events[key] if now - stamp < window_seconds]
            if len(bucket) >= limit:
                self.events[key] = bucket
                raise HTTPException(429, '请求过于频繁，请稍后再试')
            bucket.append(now)
            self.events[key] = bucket


LIMITER = RateLimiter()


def limit_for(kind: str) -> int:
    names = {
        'text': 'MJH_RATE_TEXT_PER_MINUTE',
        'image': 'MJH_RATE_IMAGE_PER_MINUTE',
        'video': 'MJH_RATE_VIDEO_PER_MINUTE',
    }
    defaults = {'text': '20', 'image': '8', 'video': '4'}
    try:
        value = int(os.getenv(names[kind], defaults[kind]))
    except ValueError:
        value = int(defaults[kind])
    return max(1, value)


def video_concurrency_limit() -> int:
    try:
        value = int(os.getenv('MJH_VIDEO_CONCURRENCY', '2'))
    except ValueError:
        value = 2
    return max(1, value)
