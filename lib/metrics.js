'use strict';

const _ = require('lodash');
const http = require('http');
const querystring = require('querystring');

const VALID_PROM_QUERY_TYPES = [
    'query',
    'query_range',
    'series',
];

module.exports.Init = function(core) {
    return {
        register_routes: function() {
            core.api.server.server.get('/:api_version/metrics/prometheus/:query_type', this.prometheus_metrics);
            core.api.server.server.get('/:api_version/metrics/prometheus/label/:label_name/values', this.prometheus_metrics);
        },

        prometheus_metrics: function(req, res, next) {
            if (req.params.query_type && 0 > VALID_PROM_QUERY_TYPES.indexOf(req.params.query_type)) {
                return res.sendStatus(400);
            }

            // retrieve all containers the containership-prometheus application is running on
            return core.applications.get_containers('containership-prometheus', (err, containers) => {
                if (err) {
                    return res.sendStatus(404);
                }

                if (!containers || 0 === containers.length) {
                    return res.sendStatus(500);
                }

                // todo: randomize which prometheus server we select from?
                const prometheusContainer = containers[0];

                const cs_proc_opts = JSON.parse(prometheusContainer.env_vars.CS_PROC_OPTS);
                const PROMETHEUS_PORT = prometheusContainer.env_vars.PROMETHEUS_PORT || 9090;

                const options = {
                    host: cs_proc_opts.legiond.network.address[core.options['legiond-scope']],
                    port: PROMETHEUS_PORT
                };

                // attach streaming response headers
                res.setHeader('Connection', 'Transfer-Encoding');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Transfer-Encoding', 'chunked');

                if (req.params.query_type) {
                    options.path = `/api/v1/${req.params.query_type}`;
                } else if(req.params.label_name) {
                    options.path = `/api/v1/label/${req.params.label_name}/values`;
                } else {
                    return res.sendStatus(400);
                }

                if (req.query) {
                    options.path += `?${querystring.stringify(req.query)}`;
                }

                options.headers = {
                    Accept: 'application/json'
                }

                const request = http.request(options, (response) => {
                    response.on('data', (chunk) => {
                        res.write(chunk);
                    });

                    return response.on('end', () => {
                        res.end();
                        request.destroy();
                    })
                });

                // trigger request to fire
                request.end();

                return req.on('close', () => {
                    request.destroy();
                });
            });
        }
    }
}
