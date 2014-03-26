#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_net = require('net');
var mod_url = require('url');
var mod_path = require('path');
var mod_fs = require('fs');

var mod_bunyan = require('bunyan');

var lib_proxy_server = require('./lib/proxy_server');

var LOG = new mod_bunyan.createLogger({
	name: 'proxy-server',
	level: process.env.LOG_LEVEL || mod_bunyan.debug,
	serializers: mod_bunyan.stdSerializers
});

var CONFIG;
var PS;

function
read_config()
{
	var cfg;
	var path = mod_path.join(__dirname, 'etc', 'proxy.json');

	try {
		cfg = JSON.parse(mod_fs.readFileSync(path, 'utf8'));

		/*
		 * Adjust Bunyan Log Level, if specified.
		 */
		LOG.level(process.env.LOG_LEVEL || cfg.log_level ||
		    mod_bunyan.INFO);

		/*
		 * Unpack backend into host and port.
		 */
		try {
			var backend = mod_url.parse(cfg.backend);
			var dport = backend.protocol === 'https:' ? 443 : 80;
			cfg.backend_host = backend.hostname;
			cfg.backend_port = Number(backend.port || dport);
		} catch (ex) {
		}

		if (validate_config(cfg))
			return (cfg);

	} catch (err) {
		LOG.error({
			config_path: path,
			err: err
		}, 'could not read configuration file');
	}

	/*
	 * Return whatever configuration (if any) exists already:
	 */
	return (CONFIG);
}

function
validate_config(cfg)
{
	if (!cfg)
		return (false);

	LOG.debug({
		cfg: cfg
	}, 'validating configuration');

	if (!mod_net.isIP(cfg.bind_ip)) {
		LOG.info('configuration invalid/missing "bind_ip"');
		return (false);
	}

	if (typeof (cfg.bind_port) !== 'number') {
		LOG.info('configuration invalid/missing "bind_port"');
		return (false);
	}

	if (!Array.isArray(cfg.nameservers)) {
		LOG.info('configuration invalid/missing "nameservers"');
		return (false);
	}

	if (typeof (cfg.backend_host) !== 'string' ||
	    typeof (cfg.backend_port) !== 'number' ||
	    isNaN(cfg.backend_port) || cfg.backend_port < 1) {
		LOG.info('configuration invalid/missing "backend"');
		return (false);
	}

	return (true);
}

var EMIT_CONFIG_WARNING = true;
function
main()
{
	CONFIG = read_config();

	if (!CONFIG) {
		if (EMIT_CONFIG_WARNING) {
			LOG.info('could not read configuration; sleeping...');
			EMIT_CONFIG_WARNING = false;
		}
		setTimeout(main, 30 * 1000);
		return;
	} else {
		LOG.info('configuration valid; starting...');
	}

	PS = new lib_proxy_server.ProxyServer({
		log: LOG,
		bind_port: CONFIG.bind_port,
		bind_ip: CONFIG.bind_ip,
		backend_host: CONFIG.backend_host,
		backend_port: CONFIG.backend_port,
		nameservers: [
			{ address: '8.8.8.8', port: 53, type: 'udp' },
			{ address: '8.8.4.4', port: 53, type: 'udp' }
		]
	});
}

main();
