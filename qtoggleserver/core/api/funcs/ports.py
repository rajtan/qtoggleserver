
import asyncio

from typing import List

from qtoggleserver.conf import settings
from qtoggleserver.core import api as core_api
from qtoggleserver.core import main
from qtoggleserver.core import ports as core_ports
from qtoggleserver.core import vports as core_vports
from qtoggleserver.core.api import schema as core_api_schema
from qtoggleserver.core.typing import Attribute, Attributes, GenericJSONDict, NullablePortValue, PortValue
from qtoggleserver.utils import json as json_utils


@core_api.api_call(core_api.ACCESS_LEVEL_VIEWONLY)
async def get_ports(request: core_api.APIRequest) -> List[Attributes]:
    return [await port.to_json() for port in sorted(core_ports.all_ports(), key=lambda p: p.get_id())]


@core_api.api_call(core_api.ACCESS_LEVEL_ADMIN)
async def patch_port(request: core_api.APIRequest, port_id: str, params: Attributes) -> None:
    port = core_ports.get(port_id)
    if port is None:
        raise core_api.APIError(404, 'no-such-port')

    non_modifiable_attrs = await port.get_non_modifiable_attrs()

    def unexpected_field_code(field: str) -> str:
        if field in non_modifiable_attrs:
            return 'attribute-not-modifiable'

        else:
            return 'no-such-attribute'

    core_api_schema.validate(
        params,
        await port.get_schema(),
        unexpected_field_code=unexpected_field_code
    )

    # Step validation
    attrdefs = await port.get_attrdefs()
    for name, value in params.items():
        attrdef = attrdefs[name]
        step = attrdef.get('step')
        _min = attrdef.get('min')
        if None not in (step, _min) and step != 0 and (value - _min) % step:
            raise core_api.APIError(400, 'invalid-field', field=name)

    errors_by_name = {}

    async def set_attr(attr_name: str, attr_value: Attribute) -> None:
        core_api.logger.debug('setting attribute %s = %s on %s', attr_name, json_utils.dumps(attr_value), port)

        try:
            await port.set_attr(attr_name, attr_value)

        except Exception as e:
            errors_by_name[attr_name] = e

    if params:
        await asyncio.wait([set_attr(name, value) for name, value in params.items()])

    if errors_by_name:
        name, error = next(iter(errors_by_name.items()))

        if isinstance(error, core_api.APIError):
            raise error

        elif isinstance(error, core_ports.InvalidAttributeValue):
            raise core_api.APIError(400, 'invalid-field', field=name, details=error.details)

        elif isinstance(error, core_ports.PortTimeout):
            raise core_api.APIError(504, 'port-timeout')

        elif isinstance(error, core_ports.PortError):
            raise core_api.APIError(502, 'port-error', code=str(error))

        else:
            # Transform any unhandled exception into APIError(500)
            raise core_api.APIError(500, 'unexpected-error', message=str(error)) from error

    await port.save()


@core_api.api_call(core_api.ACCESS_LEVEL_ADMIN)
async def post_ports(request: core_api.APIRequest, params: GenericJSONDict) -> Attributes:
    core_api_schema.validate(params, core_api_schema.POST_PORTS)

    port_id = params['id']
    port_type = params['type']
    _min = params.get('min')
    _max = params.get('max')
    integer = params.get('integer')
    step = params.get('step')
    choices = params.get('choices')

    if core_ports.get(port_id):
        raise core_api.APIError(400, 'duplicate-port')

    if len(core_vports.all_port_args()) >= settings.core.virtual_ports:
        raise core_api.APIError(400, 'too-many-ports')

    core_vports.add(port_id, port_type, _min, _max, integer, step, choices)
    port = await core_ports.load_one(
        'qtoggleserver.core.vports.VirtualPort',
        {
            'port_id': port_id,
            '_type': port_type,
            '_min': _min,
            '_max': _max,
            'integer': integer,
            'step': step,
            'choices': choices
        }
    )

    # A virtual port is enabled by default
    await port.enable()
    await port.save()

    return await port.to_json()


@core_api.api_call(core_api.ACCESS_LEVEL_ADMIN)
async def delete_port(request: core_api.APIRequest, port_id: str) -> None:
    port = core_ports.get(port_id)
    if not port:
        raise core_api.APIError(404, 'no-such-port')

    if not isinstance(port, core_vports.VirtualPort):
        raise core_api.APIError(400, 'port-not-removable')

    await port.remove()
    core_vports.remove(port_id)


@core_api.api_call(core_api.ACCESS_LEVEL_VIEWONLY)
async def get_port_value(request: core_api.APIRequest, port_id: str) -> NullablePortValue:
    port = core_ports.get(port_id)
    if port is None:
        raise core_api.APIError(404, 'no-such-port')

    if not port.is_enabled():
        return

    # TODO
    # Given the fact that get_value() simply returns last cached read value, and the fact that API specs indicate that
    # 502/504 be returned by GET /port/[id]/value in case of errors, we should remember the last error generated by
    # read_value() and return it here, if any.

    return port.get_value()


@core_api.api_call(core_api.ACCESS_LEVEL_NORMAL)
async def patch_port_value(request: core_api.APIRequest, port_id: str, params: PortValue) -> None:
    port = core_ports.get(port_id)
    if port is None:
        raise core_api.APIError(404, 'no-such-port')

    try:
        core_api_schema.validate(params, await port.get_value_schema())

    except core_api.APIError:
        # Transform any validation error into an invalid-field APIError for value
        raise core_api.APIError(400, 'invalid-value') from None

    value = params

    # Step validation
    step = await port.get_attr('step')
    _min = await port.get_attr('min')
    if None not in (step, _min) and step != 0 and (value - _min) % step:
        raise core_api.APIError(400, 'invalid-value')

    if not port.is_enabled():
        raise core_api.APIError(400, 'port-disabled')

    if not await port.is_writable():
        raise core_api.APIError(400, 'read-only-port')

    old_value = port.get_value()

    try:
        await port.write_transformed_value(value, reason=core_ports.CHANGE_REASON_API)

    except core_ports.PortTimeout as e:
        raise core_api.APIError(504, 'port-timeout') from e

    except core_ports.PortError as e:
        raise core_api.APIError(502, 'port-error', code=str(e)) from e

    except core_api.APIError:
        raise

    except Exception as e:
        # Transform any unhandled exception into APIError(500)
        raise core_api.APIError(500, 'unexpected-error', message=str(e)) from e

    # If port value hasn't really changed, trigger a value-change to inform consumer that new value has been ignored
    current_value = port.get_value()
    if (old_value == current_value) and (old_value != value):
        port.debug('API supplied value was ignored')
        await port.trigger_value_change()


@core_api.api_call(core_api.ACCESS_LEVEL_NORMAL)
async def patch_port_sequence(request: core_api.APIRequest, port_id: str, params: GenericJSONDict) -> None:
    port = core_ports.get(port_id)
    if port is None:
        raise core_api.APIError(404, 'no-such-port')

    core_api_schema.validate(params, core_api_schema.PATCH_PORT_SEQUENCE)

    values = params['values']
    delays = params['delays']
    repeat = params['repeat']

    if len(values) != len(delays):
        raise core_api.APIError(400, 'invalid-field', field='delays')

    value_schema = await port.get_value_schema()
    step = await port.get_attr('step')
    _min = await port.get_attr('min')
    for value in values:
        # Translate any APIError generated when validating value schema into an invalid-field APIError on value
        try:
            core_api_schema.validate(value, value_schema)

        except core_api.APIError:
            raise core_api.APIError(400, 'invalid-field', field='values') from None

        # Step validation
        if None not in (step, _min) and step != 0 and (value - _min) % step:
            raise core_api.APIError(400, 'invalid-field', field='values')

    if not port.is_enabled():
        raise core_api.APIError(400, 'port-disabled')

    if not await port.is_writable():
        raise core_api.APIError(400, 'read-only-port')

    if await port.get_attr('expression'):
        raise core_api.APIError(400, 'port-with-expression')

    try:
        await port.set_sequence(values, delays, repeat)

    except Exception as e:
        # Transform any unhandled exception into APIError(500)
        raise core_api.APIError(500, 'unexpected-error', message=str(e)) from e
