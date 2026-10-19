"""Encrypt per-user model keys. The Fernet key lives only in the server environment."""
from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException


class KeyBox:
    def __init__(self, key: str):
        try:
            self._fernet = Fernet(key.encode('ascii'))
        except (ValueError, TypeError) as exc:
            raise HTTPException(503, '服务端加密密钥无效') from exc

    @classmethod
    def from_env(cls) -> 'KeyBox':
        key = os.getenv('MJH_CONFIG_ENCRYPTION_KEY', '').strip()
        if not key:
            raise HTTPException(503, '服务端加密密钥未配置')
        return cls(key)

    def encrypt(self, secret: str) -> str:
        return self._fernet.encrypt(secret.encode('utf-8')).decode('ascii')

    def decrypt(self, token: str) -> str:
        try:
            return self._fernet.decrypt(token.encode('ascii')).decode('utf-8')
        except (InvalidToken, ValueError, TypeError) as exc:
            raise HTTPException(503, '模型密钥无法解密，请重新保存配置') from exc
