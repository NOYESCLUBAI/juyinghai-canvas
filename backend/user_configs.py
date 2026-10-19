"""Per-user model catalog. Hosted requests never fall back to process environment keys."""
from __future__ import annotations

from dataclasses import replace
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from backend.auth import AuthUser
from backend.model_configs import DEFAULT_URL, ConfigStore, catalog_entries
from backend.runtime import cloud_store


class UserConfigView:
    def __init__(self, store, user_id: str, settings):
        self.store = store
        self.user_id = user_id
        self.settings = settings

    def all(self):
        agnes = self.store.get_agnes(self.user_id)
        data = {'configs': self.store.list_models(self.user_id), 'agnes': agnes}
        return catalog_entries(self.settings, data, env_fallback=False)

    @staticmethod
    def public(entry):
        return ConfigStore.public(entry)

    def get(self, config_id, kind=None):
        entry = next((item for item in self.all() if item['id'] == config_id), None)
        if entry is None:
            raise HTTPException(404, '模型配置已不存在，请重新选择模型')
        if kind and entry['kind'] != kind:
            raise HTTPException(422, '模型配置类型不匹配')
        return dict(entry)

    def connection(self):
        data = self.store.get_agnes(self.user_id)
        if data:
            return data
        return {'base_url': DEFAULT_URL, 'api_key': ''}

    def save_connection(self, value):
        current = self.connection()
        api_key = value.api_key.strip() or current['api_key']
        if not api_key:
            raise HTTPException(422, '请填写 Agnes API Key')
        self.store.save_agnes(self.user_id, value.base_url, api_key)

    def save(self, value, config_id=None):
        previous = None
        if config_id:
            try:
                previous = next(item for item in self.store.list_models(self.user_id) if item['id'] == config_id)
            except StopIteration:
                previous = None
            if previous is None:
                raise HTTPException(404, '自定义模型不存在')
        entry = value.model_dump()
        from uuid import uuid4
        entry.update(id=config_id or f'custom:{uuid4().hex}', builtin=False, pricing='')
        entry['api_key'] = value.api_key.strip() or (previous['api_key'] if previous else '')
        if not entry['api_key']:
            raise HTTPException(422, '请填写 API Key')
        self.store.put_model(self.user_id, entry)
        return self.public(entry)

    def delete(self, config_id):
        self.store.delete_model(self.user_id, config_id)


def view_for(user: AuthUser, settings) -> UserConfigView:
    return UserConfigView(cloud_store(), user.id, settings)


def settings_from_entry(settings, entry: dict, kind: str):
    if not entry.get('api_key'):
        raise HTTPException(503, '未配置 API Key，请在模型管理中填写')
    selected = entry['model']
    if kind == 'text':
        result = replace(
            settings,
            base_url=entry['base_url'],
            api_key=entry['api_key'],
            model=selected,
            models=(selected,),
            enable_thinking=settings.enable_thinking if entry.get('builtin') else False,
        )
    elif kind == 'image':
        result = replace(
            settings,
            image_base_url=entry['base_url'],
            image_api_key=entry['api_key'],
            image_provider=entry['protocol'].split('-')[0],
            image_model=selected,
            image_models=(selected,),
        )
    else:
        parsed = urlsplit(entry['base_url'])
        query = entry.get('query_base_url') or urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))
        result = replace(
            settings,
            video_base_url=entry['base_url'],
            video_query_base_url=query,
            video_api_key=entry['api_key'],
            video_model=selected,
            video_models=(selected,),
        )
    return result, selected, entry


def hosted_settings(user: AuthUser | None, settings, kind: str, config_id: str | None, model: str | None):
    del model
    if user is None:
        raise HTTPException(401, '请先登录')
    if not config_id:
        raise HTTPException(422, '请选择已保存的模型配置')
    entry = view_for(user, settings).get(config_id, kind)
    return settings_from_entry(settings, entry, kind)
