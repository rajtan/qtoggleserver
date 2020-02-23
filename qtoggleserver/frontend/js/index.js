/**
 * @namespace qtoggle
 */

import {gettext}                  from '$qui/base/i18n.js'
import Config                     from '$qui/config.js'
import * as QUI                   from '$qui/index.js'
import {StickyConfirmMessageForm} from '$qui/messages/common-message-forms.js'
import * as Navigation            from '$qui/navigation.js'
import * as PWA                   from '$qui/pwa.js'
import * as Sections              from '$qui/sections/sections.js'
import * as Window                from '$qui/window.js'

import Logger from '$qui/lib/logger.module.js'

import * as API                   from '$app/api.js'
import * as Auth                  from '$app/auth.js'
import * as Cache                 from '$app/cache.js'
import {getGlobalProgressMessage} from '$app/common/common.js'
import DashboardSection           from '$app/dashboard/dashboard-section.js'
import DevicesSection             from '$app/devices/devices-section.js'
import * as Events                from '$app/events.js'
import LoginSection               from '$app/login/login-section.js'
import PortsSection               from '$app/ports/ports-section.js'
import * as ClientSettings        from '$app/settings/client-settings.js'
import SettingsSection            from '$app/settings/settings-section.js'

import '$app/qtoggle-stock.js'


const logger = Logger.get('qtoggle')


function initConfig() {
    /* Default values for qToggle-specific config  */
    Config.slavesEnabled = false
    Config.apiURLPrefix = ''

    /* Default values for client settings */
    ClientSettings.applyConfig()
}

function handleAccessLevelChange(oldLevel, newLevel) {
    /* Whenever access level changes, reload all required data */
    if (newLevel > API.ACCESS_LEVEL_NONE) {
        Cache.load(newLevel, /* showModalProgress = */ true)
        /* There's no need for load().catch() since it retries indefinitely until success */
    }

    let portsSection = PortsSection.getInstance()
    let settingsSection = SettingsSection.getInstance()
    let devicesSection = Config.slavesEnabled ? DevicesSection.getInstance() : null

    portsSection.setButtonVisibility(newLevel >= API.ACCESS_LEVEL_ADMIN)
    settingsSection.setButtonVisibility(newLevel >= API.ACCESS_LEVEL_ADMIN)
    if (devicesSection) {
        devicesSection.setButtonVisibility(newLevel >= API.ACCESS_LEVEL_ADMIN)
    }

    /* Notify section listeners */
    let allSections = Sections.all()
    allSections.forEach(function (section) {
        section.onAccessLevelChange(oldLevel, newLevel)
    })
}

function handleAPIEvent(event) {
}

function handlePWAUpdate() {
    logger.info('new service worker detected, prompting for app update')

    let msg = gettext('A new app version has been installed. Refresh now?')

    return new StickyConfirmMessageForm({message: msg}).show().asPromise()
}

function initPWA() {
    try {
        PWA.enableServiceWorker(/* url = */ null, /* updateHandler = */ handlePWAUpdate)
    }
    catch (e) {
        logger.error(`failed to enable service worker: ${e}`)
    }

    try {
        PWA.setupManifest()
    }
    catch (e) {
        logger.error(`failed to setup manifest: ${e}`)
    }
}

function registerSections() {
    /* Initial show call for global progress message */
    getGlobalProgressMessage().show()

    Sections.register(DashboardSection)
    Sections.register(PortsSection)
    if (Config.slavesEnabled) {
        Sections.register(DevicesSection)
    }
    Sections.register(SettingsSection)
    Sections.register(LoginSection)

    Navigation.navigateInitial().then(function () {
        /* Final hide call for global progress message */
        getGlobalProgressMessage().hide()
    })
}

function main() {
    initConfig()

    Promise.resolve()
    .then(() => QUI.init())
    .then(() => initPWA())
    .then(() => registerSections())
    .then(() => API.init())
    .then(() => Events.init())
    .then(() => Auth.init())
    .then(() => Cache.init())
    .then(function () {

        API.addAccessLevelChangeListener(handleAccessLevelChange)
        API.addEventListener(handleAPIEvent)

        Auth.whenFinalAccessLevelReady.then(level => API.startListening())

        Window.visibilityChangeSignal.connect(function (visible) {
            if (!visible) {
                return
            }

            if (!API.isListening()) {
                return
            }

            if (Config.debug) {
                return
            }

            logger.info('application became visible, reloading cache')

            Cache.setReloadNeeded()

            API.stopListening()
            API.startListening()
        })

    })
}


main()