
from qtoggleserver.core import api as core_api

from .base import Event


class SlaveDeviceEvent(Event):
    def __init__(self, slave):
        self.slave = slave

        super().__init__()

    def __str__(self):
        return '{}({}) event'.format(self._type, self.slave.get_name())


class SlaveDeviceAdd(SlaveDeviceEvent):
    REQUIRED_ACCESS = core_api.ACCESS_LEVEL_ADMIN
    TYPE = 'slave-device-add'

    async def get_params(self):
        return self.slave.to_json()


class SlaveDeviceRemove(SlaveDeviceEvent):
    REQUIRED_ACCESS = core_api.ACCESS_LEVEL_ADMIN
    TYPE = 'slave-device-remove'

    async def get_params(self):
        return {'name': self.slave.get_name()}


class SlaveDeviceUpdate(SlaveDeviceEvent):
    REQUIRED_ACCESS = core_api.ACCESS_LEVEL_ADMIN
    TYPE = 'slave-device-update'

    async def get_params(self):
        return self.slave.to_json()

    def is_duplicate(self, event):
        return isinstance(event, self.__class__) and event.slave == self.slave
