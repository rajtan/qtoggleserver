
import abc
import inspect
import logging

from qtoggleserver.core import api as core_api


logger = logging.getLogger(__name__)


class Event(metaclass=abc.ABCMeta):
    REQUIRED_ACCESS = core_api.ACCESS_LEVEL_NONE

    def __init__(self, typ, params):
        self._type = typ
        self._params = params

    async def to_json(self):
        return {
            'type': self._type,
            'params': await self._resolve_params(self._params)
        }

    async def _resolve_params(self, param):
        if isinstance(param, dict):
            for k, v in param.items():
                param[k] = await self._resolve_params(v)

            return param

        elif isinstance(param, (list, tuple)):
            param = list(param)
            for i in range(len(param)):
                param[i] = await self._resolve_params(param[i])

            return param

        elif callable(param):
            param = param()
            if inspect.isawaitable(param):
                param = await param

            return param

        elif inspect.isawaitable(param):
            return await param

        else:
            return param

    def is_duplicate(self, event):
        return False

    def __str__(self):
        return '{} event'.format(self._type)
