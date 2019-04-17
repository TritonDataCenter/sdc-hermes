/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var mod_fs = require('fs');
var mod_path = require('path');
var mod_assert = require('assert');

var mod_sdc = require('sdc-clients');
var mod_bunyan = require('bunyan');
var mod_verror = require('verror');

var lib_logsets = require('./lib/logsets');
var lib_utils = require('./lib/utils');
var lib_httpserver = require('./lib/httpserver');
var lib_zones = require('./lib/zones');
var lib_scripts = require('./lib/scripts');
var lib_servers = require('./lib/servers');

/*
 * Global program state, stored such that we can find it with the debugger:
 */
var GS = {
	/*
	 * Logging infrastructure:
	 */
	gs_log: null,

	/*
	 * Configuration:
	 */
	gs_config: null,
	gs_manta_private_key: null,

	/*
	 * Server Lookup/Tracking:
	 */
	gs_cnapi: null,
	gs_servermgr: null,
	gs_zonelist: null,

	/*
	 * Deployment:
	 */
	gs_httpserver: null,
	gs_tarstamp: null,
	gs_deployment_timeout: null,
	gs_scriptmgr: null,
	gs_current_bootstraps: []
};


/*
 * Various Utilities:
 */

function
create_cnapi_client()
{
	mod_assert.ok(GS.gs_config.cnapi, 'config.cnapi');
	mod_assert.ok(GS.gs_config.cnapi.url, 'config.cnapi.url');

	var log = GS.gs_log.child({
		component: 'CNAPI'
	});
	return (new mod_sdc.CNAPI({
		log: log,
		url: GS.gs_config.cnapi.url
	}));
}

function
read_config()
{
	var cfg;
	var path = mod_path.join(__dirname, 'etc', 'config.json');

	try {
		cfg = JSON.parse(mod_fs.readFileSync(path, 'utf8'));

		/*
		 * Try and get Manta configuration from the environment
		 * if it was not in the file:
		 */
		if (!cfg.manta)
			cfg.manta = {};
		if (!cfg.manta.user)
			cfg.manta.user = process.env.MANTA_USER;
		if (!cfg.manta.url)
			cfg.manta.user = process.env.MANTA_URL;
		if (!cfg.manta.key_id)
			cfg.manta.user = process.env.MANTA_KEY_ID;

		/*
		 * Set a default connction timeout:
		 */
		if (!cfg.manta.connect_timeout) {
			cfg.manta.connect_timeout = 6000;
		} else {
			cfg.manta.connect_timeout = Number(cfg.manta.connect_timeout);
		}

		/*
		 * Adjust Bunyan Log Level, if specified.
		 */
		GS.gs_log.level(process.env.LOG_LEVEL || cfg.log_level ||
		    mod_bunyan.INFO);

		if (cfg.service_name && cfg.service_name === 'sdc') {
			cfg.service_name = 'hermes';
		}

		/*
		 * Validate the configuration before returning it:
		 */
		if (validate_config(cfg))
			return (cfg);

	} catch (err) {
		GS.gs_log.error({
			config_path: path,
			err: err
		}, 'could not read configuration file');
	}

	/*
	 * Return whatever configuration (if any) exists already:
	 */
	return (GS.gs_config);
}

function
validate_config(cfg)
{
	if (!cfg)
		return (false);

	if (!cfg.mahi) {
		GS.gs_log.info('configuration missing "mahi"');
		return (false);
	}

	if (!cfg.manta) {
		GS.gs_log.info('configuration missing "manta"');
		return (false);
	}

	var manta_keys = [ 'user', 'url', 'key_id' ];
	for (var i = 0; i < manta_keys.length; i++) {
		if (!cfg.manta[manta_keys[i]]) {
			GS.gs_log.info('configuration missing "manta.' +
			    manta_keys[i] + '"');
			return (false);
		}
	}

	if (!cfg.service_name) {
		GS.gs_log.info('configuration missing "service_name"');
		return(false);
	}

	var valid_service = cfg.service_name === 'hermes' ||
		cfg.service_name === 'logarchiver';

	mod_assert.ok(valid_service, 'service_name must be "hermes" or ' +
		'"logarchiver"');


	var check_number = function check_number(name) {
		if (!cfg[name] || typeof (cfg[name]) !== 'number' ||
		    isNaN(cfg[name])) {
			GS.gs_log.info('configuration missing "' + name + '"');
			return (false);
		}
		return (true);
	};

	if (!check_number('port') || !check_number('max_concurrent_bootstraps'))
		return (false);

	return (true);
}

/*
 * Actor bootstrapping and configuration functions:
 */

function
bootstrap_server(server)
{
	var bslist = GS.gs_current_bootstraps;
	var max_bs = GS.gs_config.max_concurrent_bootstraps;

	/*
	 * Mark this server as presently being bootstrapped:
	 */
	if (bslist.length >= max_bs || bslist.indexOf(server.uuid()) !== -1)
		return;
	bslist.push(server.uuid());

	GS.gs_log.info({
		server: server.uuid()
	}, 'deploying actor');

	var script = GS.gs_scriptmgr.load('bootstrap.ksh', {
		ENDPOINT: GS.gs_config.admin_ip + ':' + GS.gs_config.port,
		AGENT_NAME: GS.gs_config.agent_name,
		SMF_REVISION: 'HERMES-1'
	});
	server.execute([], {}, script, function (err, res) {
		/*
		 * Unmark it again:
		 */
		var bsidx = GS.gs_current_bootstraps.indexOf(server.uuid());
		mod_assert.notStrictEqual(bsidx, -1);
		GS.gs_current_bootstraps.splice(bsidx, 1);

		if (err) {
			GS.gs_log.error({
				err: err,
				server: server.uuid()
			}, 'error deploying actor to server');
			return;
		}

		GS.gs_log.info({
			server: server.uuid()
		}, 'actor deployed');
	});
}

function
configure_server(server)
{
	if (!GS.gs_zonelist.ready()) {
		GS.gs_log.debug({
			zonelist_ready: GS.gs_zonelist.ready(),
			server: server.uuid()
		}, 'not ready to send configuration to server');
		return;
	}

	/*
	 * Send general configuration:
	 */
	server.post({
		type: 'configuration',
		datacenter_name: server.datacenter()
	});

	/*
	 * Send current logsets:
	 */
	var logsets = lib_logsets.logsets_for_server(
	    GS.gs_zonelist.get_zones_for_server(server.uuid()));
	server.post({
		type: 'logsets',
		logsets: logsets
	});

	/*
	 * Send current Manta configuration:
	 */
	server.post({
		type: 'manta',
		config: GS.gs_config.manta,
		private_key: GS.gs_manta_private_key,
		https_proxy: 'http://' + GS.gs_config.admin_ip +
		    ':3128',
		http_proxy: 'http://' + GS.gs_config.admin_ip +
		    ':3128',
		mahi: GS.gs_config.mahi
	});

	server.configured(true);
}

function
deployment_worker()
{
	var servers = GS.gs_servermgr.list();

	while (servers.length > 0) {
		/*
		 * Deploy servers in a random order so that we don't get stuck
		 * on the first N servers in the list which fail to deploy.
		 */
		var idx = Math.floor(Math.random() * servers.length);
		var server = servers.splice(idx, 1)[0];

		/*
		 * If the server is not connected, assume the actor is not
		 * present and bootstrap that server.
		 */
		if (!server.connected()) {
			bootstrap_server(server);
			continue;
		}

		if (!server.configured()) {
			configure_server(server);
			continue;
		}
	}

	var dt = new Date();
	dt.setUTCMilliseconds(0);

	/*
	 * Advanced to the next minute:
	 */
	do {
		dt.setUTCSeconds(dt.getUTCSeconds() + 1);
	} while (dt.getUTCSeconds() !== 0);

	if (GS.gs_deployment_timeout) {
		clearTimeout(GS.gs_deployment_timeout);
	}
	GS.gs_deployment_timeout = setTimeout(function () {
		GS.gs_deployment_timeout = null;
		deployment_worker();
	}, dt.valueOf() - Date.now());
}

/*
 * Initialisation:
 */

var EMIT_CONFIG_WARNING = true;
function
main()
{
	var log = GS.gs_log;

	GS.gs_config = read_config();
	if (!GS.gs_config) {
		if (EMIT_CONFIG_WARNING) {
			log.info('could not read configuration; sleeping...');
			EMIT_CONFIG_WARNING = false;
		}
		setTimeout(main, 30 * 1000);
		return;
	}

	log.info('configuration valid; starting...');

	log.debug('loading script manager');
	GS.gs_scriptmgr = new lib_scripts.ScriptManager(mod_path.join(__dirname,
	    'scripts'));

	log.debug('loading manta private key');
	GS.gs_manta_private_key = mod_fs.readFileSync('/root/.ssh/sdc.id_rsa',
	    'utf8');

	log.debug('creating CNAPI client');
	GS.gs_cnapi = create_cnapi_client();

	log.debug('creating server manager');
	GS.gs_servermgr = new lib_servers.ServerManager(log.child({
		component: 'ServerManager'
	}), GS.gs_cnapi);
	GS.gs_servermgr.deployed_version(GS.gs_tarstamp);

	log.debug('starting http server');
	GS.gs_config.agent_name = GS.gs_config.service_name === 'hermes' ?
		'hermes-actor' : 'logarchiver-agent';
	GS.gs_httpserver = new lib_httpserver.HttpServer(log.child({
		component: 'HttpServer'
	}), GS.gs_config.admin_ip, GS.gs_config.port, GS.gs_tarstamp,
	    GS.gs_scriptmgr, GS.gs_config.agent_name);

	GS.gs_httpserver.on('shed', function (shed) {
		GS.gs_servermgr.accept(shed);
	});

	log.debug('starting zone list');
	GS.gs_zonelist = new lib_zones.ZoneList(log.child({
		component: 'ZoneList'
	}), GS.gs_config.sapi.url, GS.gs_config.vmapi.url, 'sdc');

	/*
	 * Kick off periodic worker:
	 */
	log.info('starting periodic worker');
	setTimeout(deployment_worker, 5 * 1000);
}

/*
 * Generate hash for the actor tarball we will push out to CNs, and then
 * start the program:
 */
lib_utils.hash_file(mod_path.join(__dirname, 'actor.tar.gz'),
    function (err, hash) {
	if (err) {
		throw (new mod_verror.VError(err, 'hashing actor tarball'));
	}
	GS.gs_tarstamp = hash;

	lib_utils.create_logger(GS, 'hermes');

	main();
});

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
