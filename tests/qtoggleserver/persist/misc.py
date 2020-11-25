
import datetime

from qtoggleserver.persist import BaseDriver

from . import data


def test_collection_separation(driver: BaseDriver) -> None:
    id11 = driver.insert(data.COLL1, data.RECORD1)
    id12 = driver.insert(data.COLL1, data.RECORD2)
    id13 = driver.insert(data.COLL1, data.RECORD3)

    id21 = driver.insert(data.COLL2, data.RECORD1)
    driver.insert(data.COLL2, data.RECORD2)
    driver.insert(data.COLL2, data.RECORD3)

    results = driver.query(data.COLL1, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 3

    results = driver.query(data.COLL2, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 3

    record_part = {'string_key': 'value4'}
    updated = driver.update(data.COLL1, record_part=record_part, filt={'int_key': {'gt': 1}})
    assert updated == 2

    removed = driver.remove(data.COLL2, filt={'int_key': {'gt': 1}})
    assert removed == 2

    results = driver.query(data.COLL1, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 3

    assert results[0] == dict(data.RECORD1, id=id11)
    assert results[1] == dict(data.RECORD2, id=id12, string_key='value4')
    assert results[2] == dict(data.RECORD3, id=id13, string_key='value4')

    results = driver.query(data.COLL2, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 1

    assert results[0] == dict(data.RECORD1, id=id21)


def test_data_type_datetime(driver: BaseDriver) -> None:
    record = {
        'value1': datetime.datetime(2020, 3, 14, 0, 0, 0),
        'value2': datetime.datetime(2020, 3, 14, 23, 59, 59)
    }
    id_ = driver.insert(data.COLL1, record)

    results = driver.query(data.COLL1, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 1
    assert results[0] == dict(record, id=id_)


def test_data_type_list(driver: BaseDriver) -> None:
    record = {
        'value': ['string', 10, 3.14, True, None]
    }
    id_ = driver.insert(data.COLL1, record)

    results = driver.query(data.COLL1, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 1
    assert results[0] == dict(record, id=id_)


def test_data_type_dict(driver: BaseDriver) -> None:
    record = {
        'value': {
            'int': 10,
            'float': 3.14,
            'str': 'string',
            'bool': True,
            'null': None
        }
    }
    id_ = driver.insert(data.COLL1, record)

    results = driver.query(data.COLL1, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 1
    assert results[0] == dict(record, id=id_)


def test_data_type_complex(driver: BaseDriver) -> None:
    record = {
        'value': {
            'int': 10,
            'float': 3.14,
            'str': 'string',
            'bool': True,
            'null': None,
            'list': ['string', 10, 3.14, True, None],
            'dict': {
                'int1': 11,
                'float1': 3.14,
                'str1': 'string1',
                'bool1': False,
                'null1': None,
            }
        }
    }
    id_ = driver.insert(data.COLL1, record)

    results = driver.query(data.COLL1, fields=None, filt={}, sort=[], limit=None)
    results = list(results)
    assert len(results) == 1
    assert results[0] == dict(record, id=id_)
