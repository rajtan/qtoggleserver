
import abc
import calendar
import datetime
import time

from typing import Set

from qtoggleserver import system

from .functions import function, Function
from .exceptions import InvalidArgument, EvalSkipped


class DateUnitFunction(Function, metaclass=abc.ABCMeta):
    MIN_ARGS = 0
    MAX_ARGS = 1

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        if len(self.args) > 0:
            timestamp = int(self.args[0].eval())

        else:
            timestamp = int(time.time())

        return self.extract_unit(datetime.datetime.fromtimestamp(timestamp))

    @abc.abstractmethod
    def extract_unit(self, dt: datetime.datetime) -> int:
        raise NotImplementedError()


@function('YEAR')
class YearFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.year


@function('MONTH')
class MonthFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.month


@function('DAY')
class DayFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.day


@function('DOW')
class DOWFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.weekday()


@function('LDOM')
class LDOMFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return calendar.monthrange(dt.year, dt.month)[1]


@function('HOUR')
class HourFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.hour


@function('MINUTE')
class MinuteFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.minute


@function('SECOND')
class SecondFunction(DateUnitFunction):
    def extract_unit(self, dt: datetime.datetime) -> int:
        return dt.second


@function('MILLISECOND')
class MillisecondFunction(Function):
    MIN_ARGS = MAX_ARGS = 0

    def get_deps(self) -> Set[str]:
        return {'millisecond'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        return datetime.datetime.now().microsecond // 1000


@function('DATE')
class DateFunction(Function):
    MIN_ARGS = MAX_ARGS = 6
    UNIT_INDEX = {u: i + 1 for i, u in enumerate(('year', 'month', 'day', 'hour', 'minute', 'second'))}

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        eval_args = [int(self.args[i].eval()) for i in range(self.MIN_ARGS)]

        try:
            return int(datetime.datetime(*eval_args).timestamp())

        except ValueError as e:
            unit = str(e).split()[0]
            index = self.UNIT_INDEX.get(unit)
            if index is None:
                raise

            raise InvalidArgument(index, eval_args[index])


@function('BOY')
class BOYFunction(Function):
    MIN_ARGS = MAX_ARGS = 1

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        now = datetime.datetime.now()
        n = int(self.args[0].eval())

        return datetime.datetime(now.year + n, 1, 1, 0, 0, 0).timestamp()


@function('BOM')
class BOMFunction(Function):
    MIN_ARGS = MAX_ARGS = 1

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        now = datetime.datetime.now()
        n = int(self.args[0].eval())

        year, month = now.year, now.month
        if n >= 0:
            for _ in range(n):
                if month < 12:
                    month += 1

                else:
                    year += 1
                    month = 1

        else:
            for _ in range(-n):
                if month > 1:
                    month -= 1

                else:
                    year -= 1
                    month = 12

        return datetime.datetime(year, month, 1, 0, 0, 0).timestamp()


@function('BOW')
class BOWFunction(Function):
    MIN_ARGS = MAX_ARGS = 2

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        n = int(self.args[0].eval())
        s = int(self.args[1].eval())

        now = datetime.datetime.now()
        dt = now.replace(hour=12)  # Using mid day practically avoids problems due to DST
        dt -= datetime.timedelta(days=dt.weekday() + 7 - s)

        year, month, day = dt.year, dt.month, dt.day
        if n >= 0:
            for _ in range(n):
                last_day = calendar.monthrange(year, month)[1]
                if day + 7 <= last_day:
                    day += 7

                else:
                    day = 7 - last_day + day
                    if month < 12:
                        month += 1

                    else:
                        year += 1
                        month = 1

        else:
            for _ in range(-n):
                if day > 7:
                    day -= 7

                else:
                    if month > 1:
                        month -= 1

                    else:
                        year -= 1
                        month = 12

                    last_day = calendar.monthrange(year, month)[1]
                    day = last_day - 7 + day

        return datetime.datetime(year, month, day).timestamp()


@function('BOD')
class BODFunction(Function):
    MIN_ARGS = MAX_ARGS = 1

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        now = datetime.datetime.now()
        n = int(self.args[0].eval())
        dt = now + datetime.timedelta(days=n)
        dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)

        return dt.timestamp()


@function('HMSINTERVAL')
class HMSIntervalFunction(Function):
    MIN_ARGS = MAX_ARGS = 6

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        now = datetime.datetime.now()

        start_h = self.args[0].eval()
        start_m = self.args[1].eval()
        start_s = self.args[2].eval()
        stop_h = self.args[3].eval()
        stop_m = self.args[4].eval()
        stop_s = self.args[5].eval()

        if not (0 <= start_h <= 23):
            raise InvalidArgument(1, start_h)

        if not (0 <= start_m <= 59):
            raise InvalidArgument(2, start_m)

        if not (0 <= start_s <= 59):
            raise InvalidArgument(3, start_s)

        if not (0 <= stop_h <= 23):
            raise InvalidArgument(4, stop_h)

        if not (0 <= stop_m <= 59):
            raise InvalidArgument(5, stop_m)

        if not (0 <= stop_s <= 59):
            raise InvalidArgument(6, stop_s)

        start_time = datetime.time(int(start_h), int(start_m), int(start_s))
        stop_time = datetime.time(int(stop_h), int(stop_m), int(stop_s))

        start_dt = datetime.datetime.combine(now.date(), start_time)
        stop_dt = datetime.datetime.combine(now.date(), stop_time)

        return start_dt <= now <= stop_dt


@function('MDINTERVAL')
class MDIntervalFunction(Function):
    MIN_ARGS = MAX_ARGS = 4

    def get_deps(self) -> Set[str]:
        return {'second'}

    def eval(self) -> float:
        if not system.date.has_real_date_time():
            raise EvalSkipped()

        now = datetime.datetime.now()

        start_m = self.args[0].eval()
        start_d = self.args[1].eval()
        stop_m = self.args[2].eval()
        stop_d = self.args[3].eval()

        if not (1 <= start_m <= 12):
            raise InvalidArgument(1, start_m)

        try:
            start_dt = now.replace(month=int(start_m), day=int(start_d))

        except ValueError:
            raise InvalidArgument(2, start_d)

        if not (1 <= stop_m <= 12):
            raise InvalidArgument(3, stop_m)

        try:
            stop_dt = now.replace(month=int(stop_m), day=int(stop_d))

        except ValueError:
            raise InvalidArgument(4, stop_d)

        return start_dt <= now <= stop_dt
