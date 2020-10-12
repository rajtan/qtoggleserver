/**
 * @namespace qtoggle.api.notifications
 */

import Logger from '$qui/lib/logger.module.js'

import {AssertionError}  from '$qui/base/errors.js'
import * as Crypto       from '$qui/utils/crypto.js'
import {asap}            from '$qui/utils/misc.js'
import * as ObjectUtils  from '$qui/utils/object.js'
import * as PromiseUtils from '$qui/utils/promise.js'

import * as BaseAPI      from './base.js'
import * as APIConstants from './constants.js'


const DEFAULT_EXPECT_TIMEOUT = 60000 /* Milliseconds */
const FAST_RECONNECT_LISTEN_ERRORS = 2
const LISTEN_KEEPALIVE = 60 /* Seconds */


/**
 * Device attributes that change often and don't normally generate device-update events.
 * @alias qtoggle.api.NO_EVENT_DEVICE_ATTRS
 * @type {String[]}
 */
export const NO_EVENT_DEVICE_ATTRS = ['uptime', 'date']

const logger = Logger.get('qtoggle.api.notifications')


/**
 * A qToggle event.
 * @alias qtoggle.api.notifications.Event
 */
export class Event {

    /**
     * @constructs
     * @param {String} type the event type
     * @param {Object} params the event parameters
     * @param {Boolean} [expected] indicates that the event was expected
     * @param {Boolean} [fake] indicates that the event was generated on the client side
     */
    constructor(type, params, expected = false, fake = false) {
        this.type = type
        this.params = ObjectUtils.copy(params)
        this.expected = expected
        this.fake = fake
    }

    /**
     * Clone the event.
     * @returns {qtoggle.api.notifications.Event} the cloned event
     */
    clone() {
        return new Event(this.type, this.params, this.expected, this.fake)
    }

}

let eventListeners = []
let expectedEventSpecs = {}
let expectedEventLastHandle = 0
let sessionId = null
let listeningTime = null
let listenErrorCount = 0

/* Flag used during firmware update */
let ignoreListenErrors = false


/* Synchronization feedback */
let syncListenError = null
let syncListenCallbacks = []


/**
 * Mark an event as expected.
 * @alias qtoggle.api.notifications.expectEvent
 * @param {String} type
 * @param {*} params
 * @param {Number} [timeout]
 * @returns {Number} the expected event handle
 */
export function expectEvent(type, params, timeout = null) {
    if (timeout == null) {
        timeout = DEFAULT_EXPECT_TIMEOUT
    }

    let handle = ++expectedEventLastHandle
    expectedEventSpecs[handle] = {
        type: type,
        params: params,
        added: new Date().getTime(),
        timeout: timeout,
        handlers: []
    }

    return handle
}

/**
 * Remove an expected event handle from the expected events.
 * @alias qtoggle.api.notifications.unexpectEvent
 * @param {Number} handle
 */
export function unexpectEvent(handle) {
    let eventSpec = expectedEventSpecs[handle]
    if (eventSpec) {
        eventSpec.handlers.forEach(h => h(null, new Error('Event no longer expected')))
    }

    delete expectedEventSpecs[handle]
}

/**
 * Look up existing expected event and wait for it (or its timeout).
 * @param {String} type
 * @param {Object} [params]
 * @return {Promise}
 */
export function waitExpectedEvent(type, params = null) {
    let handle = lookupExpectedEventHandle({type, params})
    if (handle == null) {
        return Promise.reject(new Error('No such expected event'))
    }

    return new Promise(function (resolve, reject) {

        let eventSpec = expectedEventSpecs[handle]
        eventSpec.handlers.push(function (event, error = null) {
            /* Double asap() ensures that promise is settled after other event handling, such as cache updating */
            asap(function () {
                asap(function () {
                    if (error) {
                        reject(error)
                    }
                    else {
                        resolve(event)
                    }
                })
            })
        })

    })
}

function lookupExpectedEventHandle({type, params}) {
    return ObjectUtils.findKey(expectedEventSpecs, function (eventSpec) {
        if (eventSpec.type && eventSpec.type !== type) {
            return
        }

        if (eventSpec.params) {
            let mismatched = ObjectUtils.filter(eventSpec.params, function (key, value) {
                if (params[key] !== value) {
                    return true
                }
            })

            if (Object.keys(mismatched).length) {
                return
            }
        }

        return true
    })
}

function tryMatchExpectedEvent(event) {
    let handle = lookupExpectedEventHandle({type: event.type, params: event.params})
    if (handle != null) {
        let eventSpec = expectedEventSpecs[handle]
        eventSpec.handlers.forEach(h => h(event))

        delete expectedEventSpecs[handle]
        return handle
    }

    return null
}

function cleanupExpectedEvents() {
    let now = new Date().getTime()

    let expiredEventSpecs = []
    expectedEventSpecs = ObjectUtils.filter(expectedEventSpecs, function (handle, eventSpec) {
        let delta = now - eventSpec.added
        if (delta > eventSpec.timeout) {
            logger.warn(`timeout waiting for expected "${eventSpec.type}" event`)
            expiredEventSpecs.push(eventSpec)
            return false
        }

        return true
    })

    expiredEventSpecs.forEach(function (eventSpec) {
        eventSpec.handlers.forEach(h => h(null, new Error('Timeout waiting for expected event')))
    })
}

function handleServerEvent(eventData) {
    let event = new Event(eventData.type, eventData.params || {})

    let handle = tryMatchExpectedEvent(event)
    if (handle != null) {
        event.expected = true
    }

    if (APIConstants.DEBUG_API_CALLS) {
        let bodyStr = JSON.stringify(event, null, 4).replace(new RegExp('\\n', 'g'), '\n   ')
        logger.debug(`received server event "${event.type}":\n    ${bodyStr}`)
    }
    else {
        logger.debug(`received server event "${event.type}"`)
    }

    callEventListeners(event)
}

/**
 * Generate a fake server event.
 * @alias qtoggle.api.notifications.fakeServerEvent
 * @param {String} type event type
 * @param {Object} params event parameters
 */
export function fakeServerEvent(type, params) {
    let event = new Event(type, params)

    let handle = tryMatchExpectedEvent(event)
    if (handle != null) {
        event.expected = true
    }

    event.fake = true

    if (APIConstants.DEBUG_API_CALLS) {
        let bodyStr = JSON.stringify(event, null, 4).replace(new RegExp('\\n', 'g'), '\n   ')
        logger.debug(`fake server event "${event.type}":\n    ${bodyStr}`)
    }
    else {
        logger.debug(`fake server event "${event.type}"`)
    }

    callEventListeners(event)
}

function callEventListeners(event) {
    eventListeners.forEach(function (listener) {
        listener.callback.apply(listener.thisArg, [event.clone()].concat(listener.args || []))
    })
}

function wait(firstQuick = false) {
    if (!sessionId) {
        let toHash = String(new Date().getTime() * Math.random())
        let hash = new Crypto.SHA256(toHash).toString().substring(40 - 8)
        sessionId = `qtoggleserverui-${hash}`
    }

    /* Used to detect responses to listening requests that were replaced by new ones */
    let requestListeningTime = listeningTime

    let timeout = (syncListenError || firstQuick) ? 1 : LISTEN_KEEPALIVE
    let query = {
        session_id: sessionId,
        timeout: timeout
    }

    BaseAPI.apiCall({
        method: 'GET', path: '/listen', query: query, timeout: timeout + APIConstants.DEFAULT_SERVER_TIMEOUT
    }).then(function (result) {

        if (listeningTime !== requestListeningTime) {
            logger.debug('ignoring listen response from older session')
            return
        }

        asap(wait) /* Schedule the next wait call right away */
        syncListenError = null
        listenErrorCount = 0

        /* This code is enclosed in a dedicated try...catch block so that possible errors do not slip into the
         * following .catch(), thus resulting in a second, parallel wait() chain */
        try {
            syncListenCallbacks.forEach(c => PromiseUtils.asap().then(c))

            if (result && result.length) {
                result.forEach(handleServerEvent)
            }
            else {
                logger.debug('received server keep-alive')
            }
        }
        catch (error) {
            logger.errorStack('handling server event failed', error)
        }

    }).catch(function (error) {

        let reconnectSeconds = APIConstants.SERVER_RETRY_INTERVAL

        if (listeningTime !== requestListeningTime) {
            logger.debug('ignoring listen response from older session')
            return
        }

        if (ignoreListenErrors) {
            logger.debug(`ignoring listen error: ${error}`)
        }
        else {
            syncListenError = error
            listenErrorCount++

            /* Reconnect fast a few couple of time */
            if (listenErrorCount <= FAST_RECONNECT_LISTEN_ERRORS) {
                reconnectSeconds = 1
            }

            logger.error(`listen failed (reconnecting in ${reconnectSeconds} seconds)`)

            syncListenCallbacks.forEach(c => PromiseUtils.asap().then(() => c(syncListenError, reconnectSeconds)))
        }

        setTimeout(wait, reconnectSeconds * 1000) /* Schedule the next wait call later */

    })
}

/**
 * GET /webhooks API function call.
 * @alias qtoggle.api.notifications.getWebhooks
 * @returns {Promise}
 */
export function getWebhooks() {
    return BaseAPI.apiCall({method: 'GET', path: '/webhooks'})
}

/**
 * PATCH /webhooks API function call.
 * @alias qtoggle.api.notifications.patchWebhooks
 * @param {Boolean} enabled whether webhooks are enabled or not
 * @param {String} scheme the URL scheme
 * @param {String} host the host (IP address or hostname) of the client
 * @param {Number} port the TCP port
 * @param {String} path the location for the webhook request
 * @param {Number} timeout the request timeout, in seconds
 * @param {Number} retries the number of retries
 * @returns {Promise}
 */
export function patchWebhooks(enabled, scheme, host, port, path, timeout, retries) {
    let params = {
        enabled: enabled,
        scheme: scheme,
        host: host,
        port: port,
        path: path,
        timeout: timeout,
        retries: retries
    }

    return BaseAPI.apiCall({method: 'PATCH', path: '/webhooks', data: params})
}


/**
 * Event callback function.
 * @callback qtoggle.api.notifications.EventCallback
 * @param {qtoggle.api.notifications.Event} event the event
 */

/**
 * Convenience function to handle responses to GET /listen API function calls.
 * @alias qtoggle.api.notifications.addEventListener
 * @param {qtoggle.api.notifications.EventCallback} eventCallback
 * @param {*} [thisArg] the callback will be called on this object
 */
export function addEventListener(eventCallback, thisArg) {
    eventListeners.push({callback: eventCallback, thisArg: thisArg, args: arguments})
}

/**
 * Remove a previously registered event listener.
 * @alias qtoggle.api.notifications.removeEventListener
 * @param {qtoggle.api.notifications.EventCallback} eventCallback
 */
export function removeEventListener(eventCallback) {
    let index = eventListeners.findIndex(function (l) {
        return l.callback === eventCallback
    })

    if (index >= 0) {
        eventListeners.splice(index, 1)
    }
}

/**
 * Enable the listening mechanism.
 * @alias qtoggle.api.notifications.startListening
 */
export function startListening() {
    if (listeningTime) {
        throw new AssertionError('Listening mechanism already active')
    }

    logger.debug('starting listening mechanism')

    listeningTime = new Date().getTime()
    wait(/* firstQuick = */ true)
}

/**
 * Disable the listening mechanism.
 * @alias qtoggle.api.notifications.stopListening
 */
export function stopListening() {
    logger.debug('stopping listening mechanism')

    listeningTime = null
}

/**
 * Tell if the listening mechanism is currently enabled.
 * @alias qtoggle.api.notifications.isListening
 * @returns {Boolean}
 */
export function isListening() {
    return Boolean(listeningTime)
}

/**
 * Listen indication callback function.
 * @param {qtoggle.api.base.APIError} [error] indicates an error occurred during request
 * @callback qtoggle.api.notifications.SyncListenCallback
 */

/**
 * Add a function to be called each time a listen API request completes.
 * @alias qtoggle.api.notifications.addSyncListenCallback
 * @param {qtoggle.api.notifications.SyncListenCallback} listenCallback
 */
export function addSyncListenCallback(listenCallback) {
    syncListenCallbacks.push(listenCallback)
}

/**
 * Enable or disable ignoring listening errors. Useful during firmware update, when errors are expected.
 * @param {Boolean} ignore
 */
export function setIgnoreListenErrors(ignore) {
    ignoreListenErrors = ignore
}


/**
 * Initialize the notifications API subsystem.
 * @alias qtoggle.api.notifications.init
 */
export function init() {
    setInterval(cleanupExpectedEvents, 1000)
}
