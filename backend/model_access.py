"""Stable model resolver for generation routes and the Agent P0 proxy.

P0 should not read MJH_LLM_API_KEY. Depend on `backend.auth.current_user`,
then call `resolve_model_config(user, "text", model_config_id, model)`.

In hosted mode the resolver rejects a missing model_config_id and never
substitutes the operator's environment key. The browser agent should send the
signed-in user's text configuration id (the same id stored by model selection).
"""
from __future__ import annotations

from backend.auth import AuthUser


def resolve_model_config(user: AuthUser | None, kind: str, config_id: str | None = None, model: str | None = None):
    from backend.app import request_settings
    return request_settings(kind, config_id, model, user)
