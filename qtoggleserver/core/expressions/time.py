
import time

from .base import Evaluated
from .functions import function, Function


@function('TIME')
class TimeFunction(Function):
    MIN_ARGS = MAX_ARGS = 0
    DEPS = ['second']

    def eval(self) -> Evaluated:
        return int(time.time())


@function('TIMEMS')
class TimeMSFunction(Function):
    MIN_ARGS = MAX_ARGS = 0
    DEPS = ['millisecond']

    def eval(self) -> Evaluated:
        return int(time.time() * 1000)
