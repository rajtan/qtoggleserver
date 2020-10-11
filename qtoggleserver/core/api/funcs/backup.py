
import logging

from typing import List

from qtoggleserver.conf import settings
from qtoggleserver.core import api as core_api
from qtoggleserver.core.typing import GenericJSONDict
from qtoggleserver.system import conf as system_conf


logger = logging.getLogger(__name__)


@core_api.api_call(core_api.ACCESS_LEVEL_ADMIN)
async def get_backup_endpoints(request: core_api.APIRequest) -> List[GenericJSONDict]:
    endpoints = []

    if system_conf.can_write_conf_file():
        endpoints.append({
            'path': '/system',
            'display_name': 'System Configuration',
            'restore_method': 'PUT',
            'reconnect': False
        })

    if settings.frontend.enabled:
        endpoints.append({
            'path': '/frontend',
            'display_name': 'App Configuration',
            'restore_method': 'PUT',
            'reconnect': False
        })

    return endpoints
