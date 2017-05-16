'use strict';

const metrics = require('./lib/metrics');

const _ = require('lodash');
const async = require('async');
const ContainershipPlugin = require('containership.plugin');

const PLUGIN_NAME = 'containership-metrics';
const PROMETHEUS_AGENT_APPLICATION_NAME = 'containership-prometheus-agents';
const PROMETHEUS_SERVER_APPLICATION_NAME = 'containership-prometheus';

module.exports = new ContainershipPlugin({
    type: 'core',

    runFollower: function(core) {
        core.loggers[PLUGIN_NAME].log('verbose', `${PLUGIN_NAME} does not run on follower nodes.`);
    },

    runLeader: function(core) {
        const add_prometheus_agents = () => {
            core.cluster.myriad.persistence.get(
                    [core.constants.myriad.APPLICATION_PREFIX, PROMETHEUS_AGENT_APPLICATION_NAME].join(core.constants.myriad.DELIMITER),
                    (err) => {
                        if(err) {
                            return core.applications.add({
                                id: PROMETHEUS_AGENT_APPLICATION_NAME,
                                image: 'containership/prometheus-metric-targets:1.x',
                                cpus: 0.1,
                                memory: 80,
                                network_mode: 'bridge',
                                tags: {
                                    constraints: {
                                        per_host: 1
                                    },
                                    metadata: {
                                        plugin: PROMETHEUS_AGENT_APPLICATION_NAME,
                                        ancestry: 'containership.plugin'
                                    }
                                },
                                env_vars: {
                                },
                                volumes: [
                                    {
                                        host: '/',
                                        container: '/rootfs',
                                        propogation: 'ro'
                                    },
                                    {
                                        host: '/var/run',
                                        container: '/var/run',
                                        propogation: 'rw'
                                    },
                                    {
                                        host: '/sys',
                                        container: '/sys',
                                        propogation: 'ro'
                                    },
                                    {
                                        host: '/var/lib/docker',
                                        container: '/var/lib/docker',
                                        propogation: 'ro'
                                    }
                                ]
                            }, () => {
                                core.loggers[PLUGIN_NAME].log('verbose', ['Created ', PROMETHEUS_AGENT_APPLICATION_NAME, '!'].join(''));
                            });
                        }

                        return core.loggers[PLUGIN_NAME].log('verbose', [PROMETHEUS_AGENT_APPLICATION_NAME, 'already exists, skipping create!'].join(' '));
                    }
            );
        };

        let add_prometheus_timeout = null;

        const add_prometheus_server = () => {
            const available_hosts = core.cluster.legiond.get_peers();
            available_hosts.push(core.cluster.legiond.get_attributes());
            const follower_hosts = _.filter(available_hosts, (host) => host.mode === 'follower');

            // We cannot add application until we have seen atleast one follower to pin the server to
            // so set 60 second backoff and keep attempting to load server application
            // and keep attempting to load the server application
            if (follower_hosts.length === 0) {
                return setTimeout(add_prometheus_server, 60000);
            }

            // 1. check if application exists
            // 2. create app with constraint (if needed)
            // 3. check if containers have been deployed
            // 4. check if existing containers are loaded, if not re-check in 30 seconds
            // 5. if no containers are loaded, assume host constraint violated, update app, trigger another add_prometheus_check in 1 minute
            return async.waterfall([
                function checkIfAppExists(callback) {
                    return core.cluster.myriad.persistence.get([core.constants.myriad.APPLICATION_PREFIX, PROMETHEUS_SERVER_APPLICATION_NAME].join(core.constants.myriad.DELIMITER), function(err) {
                        // return false if err was returned because that means app does not exist, true otherwise
                        return callback(null, err ? false : true);
                    });
                },
                function createAppIfNeeded(exists, callback) {
                    if (exists) {
                        return callback();
                    }

                    const pinned_host = follower_hosts[Math.floor(Math.random() * follower_hosts.length)];

                    return core.applications.add({
                        id: PROMETHEUS_SERVER_APPLICATION_NAME,
                        image: 'containership/prometheus-metric-server:1.x',
                        cpus: 0.1,
                        memory: 320, // todo - configure memory based on node size
                        network_mode: 'bridge',
                        container_port: '9090',
                        tags: {
                            host_name: pinned_host.host_name,
                            metadata: {
                                plugin: PROMETHEUS_SERVER_APPLICATION_NAME,
                                ancestry: 'containership.plugin'
                            }
                        },
                        env_vars: {
                            PROMETHEUS_STORAGE_LOCAL_MEMORY_CHUNKS: 15000,
                            PROMETHEUS_STORAGE_LOCAL_MAX_CHUNKS_TO_PERSIST: 8000,
                            PROMETHEUS_STORAGE_LOCAL_NUM_FINGERPRINT_MUTEXES: 5120,
                            PROMETHEUS_STORAGE_LOCAL_RETENTION: '168h', // 7 days

                            // legacy env variables
                            PROM_MEMORY_CHUNKS: 15000,
                            PROM_MEMORY_MAX_CHUNKS_TO_PERSIST: 8000,
                            PROM_LOCAL_RETENTION: '168h' // 7 days
                        },
                        volumes: [
                            {
                                host: '/opt/containership/metrics',
                                container: '/opt/containership/metrics'
                            }
                        ]
                    }, () => {
                        core.loggers[PLUGIN_NAME].log('verbose', ['Created ', PROMETHEUS_SERVER_APPLICATION_NAME, '!'].join(''));
                        return callback();
                    });
                },
                function checkIfContainersExist(callback) {
                    return core.applications.get_containers(PROMETHEUS_SERVER_APPLICATION_NAME, (err, containers) => {
                        if (err || !containers || 0 === containers.length) {
                            return callback(null, []);
                        }

                        return callback(null, []);
                    });
                },
                function checkIfContainersAreLoaded(containers, callback) {
                    let loadedContainers = _.filter(containers, container => container.status === 'loaded');

                    // attempt to check in 30 seconds in-case container was legitimately in process of loading
                    if (0 === loadedContainers.length) {
                        return setTimeout(() => {
                            return core.applications.get_containers(PROMETHEUS_SERVER_APPLICATION_NAME, (err, containers) => {
                                if (err || !containers || 0 === containers.length) {
                                    return callback(null, {
                                        containers_deployed: false,
                                        containers_loaded: false
                                    });
                                }

                                // update loaded containers with newly fetched container list
                                loadedContainers = _.filter(containers, container => container.status === 'loaded');

                                return callback(null, {
                                    containers_deployed: containers.length > 0,
                                    containers_loaded: containers.length === loadedContainers.length && containers.length > 0
                                });
                            });
                        }, 30000);
                    }

                    return callback(null, {
                        containers_deployed: containers.length > 0,
                        containers_loaded: containers.length === loadedContainers.length && containers.length > 0
                    });
                },
                function launchContainersIfNeeded(containerInfo, callback) {
                    // no containers deployed, attempt to deploy
                    if (!containerInfo.containers_deployed) {
                        return core.applications.deploy_container(PROMETHEUS_SERVER_APPLICATION_NAME, {}, (err) => {
                            if (err) {
                                core.loggers[PLUGIN_NAME].log('error', `${PROMETHEUS_SERVER_APPLICATION_NAME} failed to deploy: ${err.message}`);
                            } else {
                                core.loggers[PLUGIN_NAME].log('verbose', `${PROMETHEUS_SERVER_APPLICATION_NAME} container deploy`);
                            }

                            return callback();
                        });
                    }

                    // container deployed but not running, try updating application constraint
                    if (containerInfo.containers_deployed && !containerInfo.containers_loaded) {
                        const pinned_host = follower_hosts[Math.floor(Math.random() * follower_hosts.length)];

                        return core.applications.add({
                            id: PROMETHEUS_SERVER_APPLICATION_NAME,
                            tags: {
                                host_name: pinned_host.host_name,
                                metadata: {
                                    plugin: PROMETHEUS_SERVER_APPLICATION_NAME,
                                    ancestry: 'containership.plugin'
                                }
                            }
                        }, () => {
                            return callback();
                        });
                    }

                    return callback();
                }
            ], () => {
                // re-check in one minute
                add_prometheus_timeout = setTimeout(add_prometheus_server, 60000);
                return;
            });
        };

        if(core.cluster.praetor.is_controlling_leader()) {
            add_prometheus_server();
            add_prometheus_agents();
        }

        core.cluster.legiond.on('demoted', () => {
            if (add_prometheus_timeout) {
                clearTimeout(add_prometheus_timeout);
            }
        });

        core.cluster.legiond.on('myriad.bootstrapped', () => {
            add_prometheus_server();
            add_prometheus_agents();
        });

        return metrics.Init(core).register_routes();
    },

    initialize: function(core) {
        if (!core || !core.logger) {
            return console.warn(`The ${PLUGIN_NAME} plugin does not support CLI initialization`);
        }

        core.logger.register(PLUGIN_NAME);

        if(core.options.mode === 'leader') {
            return module.exports.runLeader(core);
        } else if(core.options.mode === 'follower') {
            return module.exports.runFollower(core);
        } else if(core.logger) {
            core.logger.register(PLUGIN_NAME);
            return core.loggers[PLUGIN_NAME].log('error', 'Invalid configuration found when initializing containership metrics plugin!');
        }
    },

    reload: function() {}
});
