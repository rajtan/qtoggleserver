import {AssertionError, TimeoutError} from '$qui/base/errors.js'
import {gettext}                      from '$qui/base/i18n.js'
import {mix}                          from '$qui/base/mixwith.js'
import {
    CheckField, ComboField, PushButtonField,
    TextField, CompositeField
} from '$qui/forms/common-fields.js'
import {PageForm}                     from '$qui/forms/common-forms.js'
import FormButton                     from '$qui/forms/form-button.js'
import {ConfirmMessageForm}           from '$qui/messages/common-message-forms.js'
import * as Messages                  from '$qui/messages/messages.js'
import * as Toast                     from '$qui/messages/toast.js'
import * as Theme                     from '$qui/theme.js'
import * as DateUtils                 from '$qui/utils/date.js'
import * as ObjectUtils               from '$qui/utils/object.js'
import * as PromiseUtils              from '$qui/utils/promise.js'
import * as StringUtils               from '$qui/utils/string.js'
import URL                            from '$qui/utils/url.js'
import * as Window                    from '$qui/window.js'

import * as API                                  from '$app/api.js'
import * as Cache                                from '$app/cache.js'
import AttrdefFormMixin                          from '$app/common/attrdef-form-mixin.js'
import * as Common                               from '$app/common/common.js'
import ProvisioningForm                          from '$app/common/provisioning-form.js'
import RebootDeviceMixin                         from '$app/common/reboot-device-mixin.js'
import UpdateFirmwareForm                        from '$app/common/update-firmware-form.js'
import WaitDeviceMixin                           from '$app/common/wait-device-mixin.js'

import * as Devices from './devices.js'


const MASTER_FIELDS = ['url', 'enabled', 'poll_interval', 'listen_enabled', 'last_sync']

const logger = Devices.logger


function getDeviceURL(device) {
    // TODO make this function a method of Device class, once we have a Device class in place
    return new URL(device).toString()
}


/**
 * @class DeviceForm
 * @extends qui.forms.PageForm
 * @param {String} deviceName
 * @private
 */
export default class DeviceForm extends mix(PageForm).with(AttrdefFormMixin, WaitDeviceMixin, RebootDeviceMixin) {

    constructor(deviceName) {
        super({
            pathId: deviceName,
            keepPrevVisible: true,
            title: '',
            icon: Devices.DEVICE_ICON,
            closeOnApply: false,
            preventUnappliedClose: true,
            continuousValidation: true,

            fields: [
                new TextField({
                    name: 'url',
                    label: gettext('URL'),
                    readonly: true
                }),
                new CheckField({
                    name: 'enabled',
                    label: gettext('Enabled')
                }),
                new ComboField({
                    name: 'poll_interval',
                    label: gettext('Polling Interval'),
                    choices: Devices.POLL_CHOICES,
                    unit: gettext('seconds')
                }),
                new CheckField({
                    name: 'listen_enabled',
                    label: gettext('Enable Listening')
                }),
                new TextField({
                    name: 'last_sync',
                    label: gettext('Last Sync'),
                    readonly: true
                })
            ],
            buttons: [
                new FormButton({id: 'remove', caption: gettext('Remove'), style: 'danger'}),
                new FormButton({id: 'close', caption: gettext('Close'), cancel: true})
            ]
        })

        this._fullAttrdefs = null
        this._deviceName = deviceName

        this._staticFieldsAdded = false
        Devices.setRenamedDeviceName(null)
    }

    init() {
        this.updateUI()
    }

    load() {
        /* Explicitly query attributes that don't normally generate events, directly from the slave device */
        API.setSlave(this.getDeviceName())
        return API.getDevice().then(function (attrs) {
            attrs = ObjectUtils.filter(attrs, n => (API.NO_EVENT_DEVICE_ATTRS.indexOf(n) >= 0))
            attrs = ObjectUtils.mapKey(attrs, n => `attr_${n}`)
            this.setData(attrs)
        }.bind(this))
    }

    /**
     * Updates the entire form (fields & values) from the corresponding device.
     */
    updateUI() {
        let device = Cache.getSlaveDevice(this.getDeviceName())
        if (!device) {
            throw new AssertionError(`Device with name ${this.getDeviceName()} not found in cache`)
        }

        device = ObjectUtils.copy(device, /* deep = */ true)
        device.url = getDeviceURL(device)

        this._fullAttrdefs = null

        this.setTitle(device.attrs.display_name || device.name)
        this.setIcon(Devices.makeDeviceIcon(device))

        if (device.last_sync === 0) {
            device.last_sync = `(${gettext('never')})`
        }
        else {
            device.last_sync = DateUtils.formatPercent(new Date(device.last_sync * 1000), '%Y-%m-%d %H:%M:%S')
        }

        this.setData(device)

        if (device.enabled) {
            let attrdefs = ObjectUtils.copy(device.attrs.definitions || {}, /* deep = */ true)

            /* Merge in some additional attribute definitions that we happen to know of */
            ObjectUtils.forEach(API.ADDITIONAL_DEVICE_ATTRDEFS, function (name, def) {
                def = ObjectUtils.copy(def, /* deep = */ true)

                if (name in attrdefs) {
                    attrdefs[name] = ObjectUtils.combine(attrdefs[name], def)
                }
                else {
                    attrdefs[name] = def
                }
            })

            /* Combine standard and additional attribute definitions */
            this._fullAttrdefs = Common.combineAttrdefs(API.STD_DEVICE_ATTRDEFS, attrdefs)

            /* Filter out attribute definitions not applicable to this device */
            this._fullAttrdefs = ObjectUtils.filter(this._fullAttrdefs, function (name, def) {
                let showAnyway = def.showAnyway
                if (typeof showAnyway === 'function') {
                    showAnyway = showAnyway(device.attrs, this._fullAttrdefs)
                }
                return def.common || showAnyway || name in device.attrs
            }, this)

            /* Make sure all defs have a valueToUI function */
            // TODO once AttrDef becomes a class, this will no longer be necessary */
            ObjectUtils.forEach(this._fullAttrdefs, function (name, def) {
                if (!def.valueToUI) {
                    def.valueToUI = function (value) {
                        return value
                    }
                }
            })

            this.fieldsFromAttrdefs({
                attrdefs: this._fullAttrdefs,
                initialData: Common.preprocessDeviceAttrs(device.attrs),
                provisioning: device.provisioning || [],
                noUpdated: API.NO_EVENT_DEVICE_ATTRS,
                startIndex: this.getFieldIndex('last_sync') + 1
            })
        }
        else {
            /* Clear all attribute fields */
            this.fieldsFromAttrdefs()
        }

        if (!this._staticFieldsAdded) {
            this.addStaticFields()
            this._staticFieldsAdded = true
        }

        this.updateStaticFields(device.attrs)
    }

    addStaticFields() {
        this.addField(-1, new CompositeField({
            name: 'management_buttons',
            label: gettext('Manage Device'),
            separator: true,
            layout: Window.isSmallScreen() ? 'vertical' : 'horizontal',
            fields: [
                new PushButtonField({
                    name: 'reboot',
                    separator: true,
                    caption: gettext('Reboot'),
                    style: 'highlight',
                    callback(form) {
                        let device = Cache.getSlaveDevice(form.getDeviceName())
                        if (!device) {
                            throw new AssertionError(`Device with name ${form.getDeviceName()} not found in cache`)
                        }

                        let displayName = device.display_name || device.name
                        form.pushPage(form.confirmAndReboot(device.name, displayName, logger))
                    }
                }),
                new PushButtonField({
                    name: 'provision',
                    style: 'interactive',
                    caption: gettext('Provision'),
                    callback(form) {
                        form.pushPage(form.makeProvisioningForm())
                    }
                }),
                new PushButtonField({
                    name: 'firmware',
                    style: 'colored',
                    backgroundColor: Theme.getColor('@magenta-color'),
                    backgroundActiveColor: Theme.getColor('@magenta-active-color'),
                    caption: gettext('Firmware'),
                    disabled: true,
                    callback(form) {
                        form.pushPage(form.makeUpdateFirmwareForm())
                    }
                })
            ]
        }))
    }

    updateStaticFields(attrs) {
        let updateFirmwareButtonField = this.getField('management_buttons').getField('firmware')
        if (attrs.flags.indexOf('firmware') >= 0) {
            updateFirmwareButtonField.enable()
        }
        else {
            updateFirmwareButtonField.disable()
        }
    }

    getDeviceName() {
        return this._deviceName
    }

    startWaitingDeviceOnline() {
        this.setProgress()

        PromiseUtils.withTimeout(this.waitDeviceOnline(), API.SERVER_TIMEOUT * 1000).catch(function (error) {

            if (error instanceof TimeoutError) {
                this.setError(gettext('Device is offline.'))
            }

            /* Other errors can practically only be generated by cancelling the condition variable */

        }.bind(this)).then(function () {

            this.clearProgress()

        }.bind(this))
    }

    applyField(value, fieldName) {
        let device = Cache.getSlaveDevice(this.getDeviceName())
        if (!device) {
            throw new AssertionError(`Device with name ${this.getDeviceName()} not found in cache`)
        }

        /* Always work on copy */
        device = ObjectUtils.copy(device, /* deep = */ true)

        // TODO use device.isPermanentlyOffline()
        let devicePermanentlyOffline = device.poll_interval === 0 && !device.listen_enabled

        let deviceName = this.getDeviceName()

        if (MASTER_FIELDS.indexOf(fieldName) >= 0) {
            logger.debug(`updating device master property "${deviceName}.{fieldName}" to ${JSON.stringify(value)}`)
            device[fieldName] = value

            if (fieldName === 'enabled' && value && !devicePermanentlyOffline) {
                this.startWaitingDeviceOnline()
            }

            return API.patchSlaveDevice(
                deviceName,
                device.enabled,
                device.poll_interval,
                device.listen_enabled
            ).then(function () {

                logger.debug(`device master property "${deviceName}.${fieldName}" successfully updated`)

            }).catch(function (error) {

                logger.errorStack(`failed to update device master property "${deviceName}.${fieldName}"`, error)
                if (this.isWaitingDeviceOnline()) {
                    this.cancelWaitingDeviceOnline()
                }

                throw error

            }.bind(this))
        }
        else { /* A slave device attribute was updated */
            if (!this._fullAttrdefs) {
                return /* Device offline */
            }

            let name = fieldName.substring(5)
            if (!(name in this._fullAttrdefs) || !this._fullAttrdefs[name].modifiable) {
                return
            }

            logger.debug(`updating device attribute "${deviceName}.${name}" to ${JSON.stringify(value)}`)

            let newAttrs = {}
            newAttrs[name] = value

            if (name === 'name') {
                /* Device renamed, remember new name for reopening */
                Devices.setRenamedDeviceName(value)
            }

            API.setSlave(deviceName)
            return API.patchDevice(newAttrs).then(function () {

                logger.debug(`device attribute "${deviceName}.${name}" successfully updated`)

            }).catch(function (error) {

                logger.errorStack(`failed to update device attribute "${deviceName}.${name}"`, error)
                throw error

            }).then(function () {

                /* Attributes with reconnect flag will probably restart/reset the device, therefore we first wait for it
                 * to go offline and then to come back online */

                if (!this._fullAttrdefs[name].reconnect) {
                    return
                }

                this.setProgress()

                /* Following promise chain is intentionally not part of the outer chain, because by the time it
                 * resolves, the field will no longer be part of the DOM */
                Promise.resolve().then(function () {

                    return PromiseUtils.withTimeout(this.waitDeviceOffline(), Common.GO_OFFLINE_TIMEOUT * 1000)

                }.bind(this)).then(function () {

                    return PromiseUtils.withTimeout(this.waitDeviceOnline(), Common.COME_ONLINE_TIMEOUT * 1000)

                }.bind(this)).catch(function (error) {

                    logger.errorStack(`failed to set device attribute "${deviceName}.${fieldName}"`, error)

                    if (error instanceof TimeoutError) {
                        error = new Error(gettext('Timeout waiting for device to reconnect.'))
                    }

                    this.cancelWaitingDevice()
                    this.setError(error)

                }.bind(this)).then(function () {

                    this.clearProgress()

                }.bind(this))

            }.bind(this))
        }
    }

    onPush() {
        Devices.setCurrentDeviceName(this._deviceName)
    }

    onClose() {
        Devices.setCurrentDeviceName(null)
        this.cancelWaitingDevice()
    }

    onButtonPress(button) {
        switch (button.getId()) {
            case 'remove':
                this.pushPage(this.makeRemoveDeviceForm())

                break
        }
    }

    navigate(pathId) {
        switch (pathId) {
            case 'remove':
                return this.makeRemoveDeviceForm()

            case 'firmware':
                return this.makeUpdateFirmwareForm()

            case 'provisioning':
                return this.makeProvisioningForm()
        }
    }

    /**
     * @returns {qui.pages.PageMixin}
     */
    makeRemoveDeviceForm() {
        let device = Cache.getSlaveDevice(this.getDeviceName())
        if (!device) {
            throw new AssertionError(`Device with name ${this.getDeviceName()} not found in cache`)
        }

        let deviceURL = getDeviceURL(device)

        let msg = StringUtils.formatPercent(
            gettext('Really remove %(object)s?'),
            {object: Messages.wrapLabel(device.attrs.display_name || device.name)}
        )

        return new ConfirmMessageForm({
            message: msg,
            onYes: function () {

                logger.debug(`removing device "${device.name}" at url ${deviceURL}`)

                API.deleteSlaveDevice(device.name).then(function () {

                    logger.debug(`device "${device.name}" at url ${deviceURL} successfully removed`)
                    this.close(/* force = */ true)

                }.bind(this)).catch(function (error) {

                    logger.errorStack(`failed to remove device "${device.name}" at url ${deviceURL}`, error)
                    Toast.error(error.message)

                })

            }.bind(this),
            pathId: 'remove'
        })
    }

    /**
     * @returns {qui.pages.PageMixin}
     */
    makeUpdateFirmwareForm() {
        return new UpdateFirmwareForm(this.getDeviceName())
    }

    /**
     * @returns {qui.pages.PageMixin}
     */
    makeProvisioningForm() {
        return new ProvisioningForm(this.getDeviceName())
    }

}
