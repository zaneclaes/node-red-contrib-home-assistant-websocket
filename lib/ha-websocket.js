'use strict';
const debug = require('debug')('home-assistant:ws');
const EventEmitter = require('events').EventEmitter;
const homeassistant = require('home-assistant-js-websocket');
const WebSocket = require('ws');

const MSG_TYPE_AUTH_REQUIRED = 'auth_required';
const MSG_TYPE_AUTH_INVALID = 'auth_invalid';
const MSG_TYPE_AUTH_OK = 'auth_ok';
const connectionStates = ['CONNECTING', 'CONNECTED', 'DISCONNECTED', 'ERROR'];

class HaWebsocket extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.connectionState = HaWebsocket.DISCONNECTED;
        this.states = {};
        this.services = {};
        this.statesLoaded = false;
        this.client = null;
        this.subscribedEvents = new Set();
        this.unsubCallback = {};
        this.integrationVersion = 0;

        this.setMaxListeners(0);
    }

    get isConnected() {
        return this.connectionState === this.CONNECTED;
    }

    get CONNECTING() {
        return HaWebsocket.CONNECTING;
    }

    get CONNECTED() {
        return HaWebsocket.CONNECTED;
    }

    get DISCONNECTED() {
        return HaWebsocket.DISCONNECTED;
    }

    get ERROR() {
        return HaWebsocket.ERROR;
    }

    async connect() {
        this.client = await homeassistant
            .createConnection({
                self: this,
                createSocket: this.createSocket,
            })
            .catch((e) => {
                this.connectionState = HaWebsocket.ERROR;
                this.emit('ha_client:close');

                // Handle connection errors
                switch (e) {
                    case homeassistant.ERR_CANNOT_CONNECT:
                        throw new Error(
                            'Cannot connect to Home Assistant server'
                        );
                    case homeassistant.ERR_INVALID_AUTH:
                        throw new Error(
                            'Invalid access token or password for websocket'
                        );
                    case homeassistant.ERR_CONNECTION_LOST:
                        throw new Error('connection lost');
                    case homeassistant.ERR_HASS_HOST_REQUIRED:
                        throw new Error('Base URL not set in server config');
                    case homeassistant.ERR_INVALID_HTTPS_TO_HTTP:
                        throw new Error('ERR_INVALID_HTTPS_TO_HTTP');
                }
                throw e;
            });

        // Check if user has admin privileges
        const user = await this.getUser();
        if (user.is_admin === false) {
            this.connectionState = HaWebsocket.ERROR;
            this.client.close();
            throw new Error(
                'User required to have admin privileges in Home Assistant'
            );
        }

        this.onClientOpen();
        // emit connected for only the first connection to the server
        // so we can setup certain things only once like registerEvents
        this.emit('ha_client:connected');

        // Client events
        this.client.addEventListener('ready', this.onClientOpen.bind(this));
        this.client.addEventListener(
            'disconnected',
            this.onClientClose.bind(this)
        );
        this.client.addEventListener(
            'reconnect-error',
            this.onClientError.bind(this)
        );

        // Home Assistant Events
        homeassistant.subscribeEntities(this.client, (ent) =>
            this.onClientStates(ent)
        );
        homeassistant.subscribeServices(this.client, (ent) =>
            this.onClientServices(ent)
        );
        homeassistant.subscribeConfig(this.client, (config) =>
            this.onClientConfigUpdate(config)
        );

        return true;
    }

    async subscribeEvents(events) {
        const currentEvents = new Set(Object.values(events));

        // If events contains '__ALL__' register all events and skip individual ones
        if (currentEvents.has('__ALL__')) {
            if (this.subscribedEvents.has('__ALL__')) {
                // Nothing to do
                return;
            }

            this.subscribedEvents.forEach((e) => {
                if (e !== '__ALL__') {
                    this.unsubCallback[e]();
                    delete this.unsubCallback[e];
                    this.subscribedEvents.delete(e);
                }
            });

            // subscribe to all event and save unsubscribe callback
            this.unsubCallback.__ALL__ = await this.client.subscribeEvents(
                (ent) => this.onClientEvents(ent)
            );

            this.subscribedEvents.add('__ALL__');
            return;
        }

        // Always need the state_changed event
        currentEvents.add('state_changed');
        currentEvents.add('nodered');

        const add = new Set(
            [...currentEvents].filter((x) => !this.subscribedEvents.has(x))
        );
        const remove = new Set(
            [...this.subscribedEvents].filter((x) => !currentEvents.has(x))
        );

        // Create new subscription list
        this.subscribedEvents = new Set([
            ...[...currentEvents].filter((x) => this.subscribedEvents.has(x)),
            ...add,
        ]);

        // Remove unused subscriptions
        remove.forEach((e) => {
            this.unsubCallback[e]();
            delete this.unsubCallback[e];
        });

        // Subscribe to each event type and save each unsubscribe callback
        for (const type of add) {
            this.unsubCallback[type] = await this.client.subscribeEvents(
                (ent) => this.onClientEvents(ent),
                type
            );
        }
    }

    onClientStates(msg) {
        if (!msg || Object.keys(msg).length === 0) {
            return;
        }

        this.states = msg;

        if (!this.statesLoaded) {
            this.statesLoaded = true;
            this.emit('ha_client:states_loaded', this.states);
        }
    }

    onClientServices(msg) {
        if (!msg || Object.keys(msg).length === 0) {
            return;
        }

        this.services = msg;

        if (!this.servicesLoaded) {
            this.servicesLoaded = true;
            this.emit('ha_client:services_loaded', this.services);
        }
    }

    onClientEvents(msg) {
        if (!msg || !msg.data || msg.data === 'ping') {
            return;
        }

        if (msg) {
            const eventType = msg.event_type;
            const entityId = msg.data && msg.data.entity_id;

            if (eventType === 'nodered') {
                if (msg.data.type === 'loaded') {
                    this.integrationVersion = msg.data.version;
                } else if (msg.data.type === 'unloaded') {
                    this.integrationVersion = 0;
                }
                this.emit(`integration`, msg.data.type);
                return;
            }

            const emitEvent = {
                event_type: eventType,
                entity_id: entityId,
                event: msg.data,
            };

            if (
                emitEvent.entity_id &&
                emitEvent.event_type === 'state_changed' &&
                emitEvent.event &&
                emitEvent.event.new_state
            ) {
                this.states[emitEvent.entity_id] = emitEvent.event.new_state;
            }

            // Emit on the event type channel
            if (emitEvent.event_type) {
                this.emit(`ha_events:${msg.event_type}`, emitEvent);

                // Most specific emit for event_type and entity_id
                if (emitEvent.entity_id) {
                    this.emit(
                        `ha_events:${msg.event_type}:${emitEvent.entity_id}`,
                        emitEvent
                    );
                }
            }

            // Emit on all channel
            this.emit('ha_events:all', emitEvent);
        }
    }

    async onClientConfigUpdate(config) {
        this.integrationVersion = 0;
        if (config.components.includes('nodered')) {
            try {
                this.integrationVersion = await this.send({
                    type: 'nodered/version',
                });
            } catch (e) {}
        }
        this.emit('ha_events:config_update');
    }

    onClientOpen() {
        this.integrationVersion = 0;
        this.connectionState = HaWebsocket.CONNECTED;
        this.emit('ha_client:open');
    }

    onClientClose() {
        this.integrationVersion = 0;
        this.connectionState = HaWebsocket.DISCONNECTED;
        this.emit('ha_client:close');

        this.closeClient(
            null,
            'events connection closed, cleaning up connection'
        );
    }

    onClientError(data) {
        this.closeClient(
            data,
            'events connection error, cleaning up connection'
        );
    }

    closeClient(err, logMsg) {
        if (logMsg) {
            debug(logMsg);
        }
        if (err) {
            debug(err);
            this.emit('ha_client:error', err);
        }

        this.servicesLoaded = false;
        this.statesLoaded = false;

        if (this.client && this.client.readyState === this.client.CLOSED) {
            this.connectionState = HaWebsocket.DISCONNECTED;
            this.emit('ha_client:close');
        }
    }

    async getUser() {
        return homeassistant.getUser(this.client);
    }

    async getStates(entityId, forceRefresh = false) {
        if (Object.keys(this.states).length === 0 || forceRefresh) {
            // TODO: handle forceRefresh and empty state object
        }
        let data;
        if (entityId) {
            data = this.states[entityId] ? { ...this.states[entityId] } : null;
        } else {
            data = { ...this.states };
        }

        return data;
    }

    async getServices(forceRefresh = false) {
        if (forceRefresh) {
            // TODO: handle forceRefresh and empty state object
        }
        return { ...this.services };
    }

    async callService(domain, service, data) {
        const result = homeassistant.callService(
            this.client,
            domain,
            service,
            data
        );

        return result;
    }

    async send(data) {
        const response = await this.client.sendMessagePromise(data);

        return response;
    }

    /*
     * Pretty much a copy from https://github.com/home-assistant/home-assistant-js-websocket
     */
    createSocket() {
        const self = this.self;

        // Convert from http:// -> ws://, https:// -> wss://
        const url = `ws${self.config.baseUrl.substr(4)}/api/websocket`;

        const authObj = {
            type: 'auth',
        };

        authObj[self.config.legacy ? 'api_password' : 'access_token'] =
            self.config.apiPass;

        debug('[Auth Phase] Initializing', url);

        function connect(promResolve, promReject) {
            debug('[Auth Phase] New connection', url);
            self.connectionState = self.CONNECTING;
            self.emit('ha_client:connecting');

            const socket = new WebSocket(url, {
                rejectUnauthorized: self.config.rejectUnauthorizedCerts,
            });

            // If invalid auth, we will not try to reconnect.
            let invalidAuth = false;

            const onOpen = async (event) => {
                try {
                    socket.send(JSON.stringify(authObj));
                } catch (err) {
                    invalidAuth = err === homeassistant.ERR_INVALID_AUTH;
                    socket.close();
                }
            };

            const onMessage = async (event) => {
                const message = JSON.parse(event.data);

                debug('[Auth Phase] Received', message);

                switch (message.type) {
                    case MSG_TYPE_AUTH_INVALID:
                        invalidAuth = true;
                        socket.close();
                        break;

                    case MSG_TYPE_AUTH_OK:
                        socket.removeEventListener('open', onOpen);
                        socket.removeEventListener('message', onMessage);
                        socket.removeEventListener('close', onClose);
                        socket.removeEventListener('error', onClose);
                        promResolve(socket);
                        break;

                    default:
                        if (message.type !== MSG_TYPE_AUTH_REQUIRED) {
                            debug('[Auth Phase] Unhandled message', message);
                        }
                }
            };

            const onClose = () => {
                // If we are in error handler make sure close handler doesn't also fire.
                socket.removeEventListener('close', onClose);
                if (invalidAuth) {
                    promReject(homeassistant.ERR_INVALID_AUTH);
                    return;
                }

                // Try again in a second
                setTimeout(() => connect(promResolve, promReject), 5000);
            };

            socket.addEventListener('open', onOpen);
            socket.addEventListener('message', onMessage);
            socket.addEventListener('close', onClose);
            socket.addEventListener('error', onClose);
        }

        return new Promise((resolve, reject) => {
            // if hass.io, do a 5 second delay so it doesn't spam the hass.io proxy
            // https://github.com/zachowj/node-red-contrib-home-assistant-websocket/issues/76
            setTimeout(
                () => connect(resolve, reject),
                self.config.connectionDelay !== false ? 5000 : 0
            );
        });
    }
}

connectionStates.forEach((readyState, i) => {
    HaWebsocket[connectionStates[i]] = i;
});

module.exports = HaWebsocket;
