
import abc
import asyncio
import functools
import logging

from typing import Any, Callable, Dict, List, Optional, Type, Union

from qtoggleserver.core import ports as core_ports
from qtoggleserver.utils import conf as conf_utils
from qtoggleserver.utils import logging as logging_utils

from .threadedrunner import ThreadedRunner


logger = logging.getLogger(__name__)


class Peripheral(conf_utils.ConfigurableMixin, logging_utils.LoggableMixin, metaclass=abc.ABCMeta):
    RUNNER_CLASS = ThreadedRunner
    RUNNER_QUEUE_SIZE = 8

    logger = logger

    def __init__(self, name: str, **kwargs) -> None:
        logging_utils.LoggableMixin.__init__(self, name, self.logger)

        self._name = name
        self._ports = []
        self._enabled = False
        self._online = False
        self._runner = None

    def __str__(self) -> str:
        return self._name

    def get_name(self) -> str:
        return self._name

    def get_port_args(self) -> List[Dict[str, Any]]:
        port_args = self.make_port_args()

        # Transform port classes to dicts with drivers
        port_args = [
            {'driver': pa} if isinstance(pa, type) else pa
            for pa in port_args
        ]

        # Supply the peripheral argument
        for pa in port_args:
            pa.setdefault('peripheral', self)

        return port_args

    @abc.abstractmethod
    def make_port_args(self) -> List[Union[Dict[str, Any], Type[core_ports.BasePort]]]:
        raise NotImplementedError()

    def set_ports(self, ports: List[core_ports.BasePort]) -> None:
        self._ports = ports

    def get_ports(self) -> List[core_ports.BasePort]:
        return list(self._ports)

    def is_enabled(self) -> bool:
        return self._enabled

    async def enable(self) -> None:
        if self._enabled:
            return

        self._enabled = True
        await self.handle_enable()
        self.debug('peripheral enabled')

    async def disable(self) -> None:
        if not self._enabled:
            return

        self._enabled = False
        await self.handle_disable()
        self.debug('peripheral disabled')

    async def check_disabled(self, exclude_port: Optional[core_ports.BasePort] = None) -> None:
        if not self._enabled:
            return

        for port in self._ports:
            if port.is_enabled() and port != exclude_port:
                break

        else:
            self.debug('all ports are disabled, disabling peripheral')
            await self.disable()

    def is_online(self) -> bool:
        return self._enabled and self._online

    def set_online(self, online: bool) -> None:
        if online and not self._online:
            self.debug('is online')
            self.handle_online()

        elif not online and self._online:
            self.debug('is offline')
            self.handle_offline()

        self._online = online

    def handle_offline(self) -> None:
        self.trigger_port_update()

    def handle_online(self) -> None:
        self.trigger_port_update()

    def trigger_port_update(self) -> None:
        for port in self._ports:
            if port.is_enabled():
                port.trigger_update()

    def get_runner(self) -> ThreadedRunner:
        if self._runner is None:
            self._runner = self.make_runner()

        return self._runner

    def make_runner(self) -> ThreadedRunner:
        self.debug('starting threaded runner')
        runner = self.RUNNER_CLASS(queue_size=self.RUNNER_QUEUE_SIZE)
        runner.start()

        return runner

    async def run_threaded(self, func: Callable, *args, **kwargs) -> Any:
        future = asyncio.get_running_loop().create_future()

        def callback(result: Any, exception: Optional[Exception]) -> None:
            if exception:
                future.set_exception(exception)

            else:
                future.set_result(result)

        runner = self.get_runner()
        runner.schedule_func(functools.partial(func, *args, **kwargs), callback)

        return await future

    async def handle_enable(self) -> None:
        pass

    async def handle_disable(self) -> None:
        pass

    async def handle_init(self) -> None:
        pass

    async def handle_cleanup(self) -> None:
        if self._runner:
            self.debug('stopping threaded runner')
            await self._runner.stop()
            self.debug('threaded runner stopped')