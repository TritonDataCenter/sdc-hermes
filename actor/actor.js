/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var mod_child = require('child_process');
var mod_fs = require('fs');
var mod_os = require('os');
var mod_path = require('path');

var mod_assert = require('assert-plus');
var mod_backoff = require('backoff');
var mod_jsprim = require('jsprim');
var mod_mahi = require('mahi');
var mod_manta = require('manta');
var mod_vasync = require('vasync');
var mod_yakaa = require('yakaa');

var lib_utils = require('./lib/utils');
var lib_conn = require('./lib/conn');
var lib_logsets = require('./lib/logsets');
var lib_cmd = require('./lib/cmd');
var lib_worker = require('./lib/worker');

/*
 * XXX Work around node-bunyan#119, "Don't JSON Buffers past a certain length"
 */
Buffer.prototype.toJSON = Buffer.prototype.inspect;

mod_assert.string(process.env.SMF_FMRI, 'SMF_FMRI not set');

/*
 * Global program state, stored such that we can find it with the debugger.
 */
var GS = {
	/*
	 * Logging infrastructure:
	 */
	gs_log: null,

	/*
	 * smf(5) constants:
	 */
	gs_ifmri: process.env.SMF_FMRI,
	gs_sfmri: process.env.SMF_FMRI.replace(/:default$/, ''),

	gs_worker: {
		timeout: null,
		enabled: false,
		logset_queue: [],
		running: {}
	},

	gs_sysinfo: null,
	gs_dcname: null,
	gs_deployed_version: null,

	/*
	 * Server connection:
	 */
	gs_server_address: null,
	gs_shed: null,
	gs_backoff: null,
	gs_heartbeat_timeout: null,

	gs_mahi: {
		client: null
	},

	gs_manta: {
		agent: null,
		client: null,
		user: null
	}
};

function
redeploy(_, next)
{
	mod_vasync.pipeline({
		funcs: [
			lib_cmd.svccfg.bind(null, [ '-s', GS.gs_sfmri,
			    'setprop hermes/redeploy = true' ]),
			lib_cmd.svcadm.bind(null, [ 'refresh', GS.gs_ifmri ]),
			lib_cmd.svcadm.bind(null, [ 'restart', GS.gs_ifmri ])
		]
	}, function (err) {
		if (err) {
			GS.gs_log.error({
				err: err
			}, 'failed to initiate redeployment');
		}
		if (next)
			next(err);
	});
}

function
get_server(_, next)
{
	lib_cmd.svcprop([ '-p', 'hermes/server', GS.gs_ifmri ],
	    function (err, val) {
		if (err) {
			next(err);
			return;
		}

		GS.gs_server_address = val;
		next();
	});
}

function
get_deployed_version(_, next)
{
	var path = mod_path.join(__dirname, '.version');
	var opts = {
		encoding: 'utf8'
	};
	mod_fs.readFile(path, opts, function (err, data) {
		if (err) {
			next(err);
			return;
		}

		GS.gs_deployed_version = data.trim();
		next();
	});
}

function
get_sysinfo(_, next)
{
	mod_child.execFile('/usr/bin/sysinfo', function (err, stdout, stderr) {
		if (err) {
			next(err);
			return;
		}

		try {
			GS.gs_sysinfo = JSON.parse(stdout);
		} catch (ex) {
			next(ex);
			return;
		}

		/*
		 * If you try, sometimes, you might just find you get what
		 * you need:
		 */
		mod_assert.string(GS.gs_sysinfo['UUID'],
		    'sysinfo "UUID"');

		next();
	});
}

function
setup_connection()
{
	mod_assert.ok(!GS.gs_backoff, 'setup_connection called twice');

	GS.gs_backoff = mod_backoff.fibonacci({
		randomisationFactor: 0.5,
		initialDelay: 1000,
		maxDelay: 30000
	});

	GS.gs_backoff.on('ready', connect);

	GS.gs_backoff.on('backoff', function (number, delay, err) {
		GS.gs_log.debug({
			number: number,
			delay: delay,
			err: err
		}, 'server connection backoff');
	});

	GS.gs_backoff.backoff();
}

function
connect()
{
	lib_conn.connect_server(GS.gs_server_address, function (err, shed) {
		mod_assert.ok(!GS.gs_shed, 'connected twice');

		if (err) {
			GS.gs_log.error({
				err: err
			}, 'failed to connect to server; retrying...');
			GS.gs_backoff.backoff(err);
			return;
		}

		var error;
		var was_reset = false;

		shed.on('error', function (_err) {
			error = _err;
			GS.gs_log.error({
				err: _err
			}, 'server connection error');
		});

		shed.on('connectionReset', function () {
			GS.gs_log.warn('server connection reset');
			was_reset = true;
		});

		shed.on('end', function (code, reason) {
			GS.gs_log.info({
				code: code,
				reason: reason,
				was_reset: was_reset
			}, 'server connection ended; reconnecting...');
			cancel_log_workers();
			GS.gs_shed = null;
			/*
			 * Back off, man, I'm a scientist.
			 */
			GS.gs_backoff.backoff(error);
		});

		shed.on('text', function (text) {
			var obj = JSON.parse(text);

			handle_message(obj);
		});

		shed.send(JSON.stringify({
			type: 'identify',
			server_uuid: GS.gs_sysinfo['UUID'],
			deployed_version: GS.gs_deployed_version,
			pid: process.pid
		}));

		GS.gs_shed = shed;

		/*
		 * Note that we do not reset our backoff here.  Instead,
		 * we do it once we get an 'identify_ok' message from the
		 * server -- i.e. once we know we're in the clear.
		 */
	});
}

function
ready_for_workers()
{
	var log = GS.gs_log;

	if (!GS.gs_worker.enabled) {
		log.trace('gs_worker.enabled is false, not ready for workers');
		return (false);
	}

	if (!GS.gs_dcname) {
		log.trace('gs_dcname not set, not ready for workers');
		return (false);
	}

	if (!GS.gs_manta || !GS.gs_manta.user || !GS.gs_manta.client) {
		log.trace('manta client not available, not ready for workers');
		return (false);
	}

	if (!lib_logsets.ready()) {
		log.trace('logsets not loaded, not ready for workers');
		return (false);
	}

	return (true);
}

function
handle_message(msg)
{
	var log = GS.gs_log;

	log.trace({
		message: msg
	}, 'received message');

	switch (msg.type) {
	case 'enable_heartbeat':
		if (GS.gs_heartbeat_timeout)
			clearInterval(GS.gs_heartbeat_timeout);
		GS.gs_heartbeat_timeout = setInterval(function () {
			if (!GS.gs_shed) {
				clearInterval(GS.gs_heartbeat_timeout);
				GS.gs_heartbeat_timeout = null;
				return;
			}
			GS.gs_shed.send(JSON.stringify({
				type: 'heartbeat',
				when: (new Date()).toISOString(),
				hostname: mod_os.hostname()
			}));
		}, msg.timeout);
		break;

	case 'identify_ok':
		log.debug('identify_ok received; resetting backoff');
		GS.gs_backoff.reset();
		/*
		 * The worker should run again:
		 */
		GS.gs_worker.enabled = true;
		break;

	case 'configuration':
		log.info({
			datacenter_name: msg.datacenter_name
		}, 'extra configuration received from server');
		if (msg.datacenter_name)
			GS.gs_dcname = msg.datacenter_name;
		break;

	case 'manta':
		log.info({
			config: msg.config,
			http_proxy: msg.http_proxy,
			https_proxy: msg.https_proxy,
			mahi: msg.mahi
		}, 'received manta configuration from server');

		if (GS.gs_manta.client) {
			GS.gs_manta.client.close();
		}
		if (GS.gs_mahi.client) {
			GS.gs_mahi.client.close();
		}
		if (GS.gs_manta.agent) {
			GS.gs_manta.agent.destroy();
		}

		GS.gs_mahi.client = mod_mahi.createClient({
			url: msg.mahi.url
		});

		GS.gs_manta.user = msg.config.user;

		/*
		 * We create a keepAlive Agent and give it to the Manta client
		 * for outbound requests.  If the URL is not obviously an
		 * insecure HTTP URL, we assume HTTPS.
		 *
		 * In order to funnel Manta requests through the hermes
		 * proxy (since the GZ might not have external network), we
		 * pass the appropriate proxy (determined above based on the
		 * URL) to the Manta client for outbound requests.
		 *
		 * The use of "mod_yakaa" here is extremely unfortunate.
		 * Previous versions of hermes used a hacked non-master version
		 * of node-manta that hid this. When we updated node to a newer
		 * version, this hack had to be moved to this code. Eventually
		 * this needs to be removed as yakaa existed to backport node
		 * v0.12 keepalive support for node v0.10, has not been updated
		 * in more than 4 years, and was never the right place to include
		 * proxy support.
		 *
		 */
		if (mod_jsprim.startsWith(msg.config.url, 'http:')) {
			GS.gs_manta.agent = new mod_yakaa({
				keepAlive: true,
				proxy: msg.http_proxy
			});
		} else {
			GS.gs_manta.agent = new mod_yakaa.SSL({
				keepAlive: true,
				proxy: msg.https_proxy
			});
		}

		GS.gs_manta.client = mod_manta.createClient({
			sign: mod_manta.privateKeySigner({
				key: msg.private_key,
				keyId: msg.config.key_id,
				user: msg.config.user
			}),
			user: msg.config.user,
			url: msg.config.url,
			connectTimeout: msg.config.connect_timeout,
			retry: false,
			agent: GS.gs_manta.agent
		});
		break;

	case 'logsets':
		log.info({
			logsets: msg.logsets
		}, 'received logsets from server');

		lib_logsets.use_logsets(msg.logsets);
		break;

	case 'redeploy':
		log.info('server triggered redeployment');
		cancel_log_workers();
		redeploy();
		break;

	case 'shutdown':
		log.info('server triggered shutdown');
		cancel_log_workers();
		GS.gs_shed.end('shutting down');
		log.info('shutdown requested, disabling service.');
		var args = [
			'disable',
			'-s',
			process.env.SMF_FMRI
		];
		mod_child.execFile('/usr/sbin/svcadm', args,
		    function () {
			setTimeout(function () {
				/*
				 * Should not reach here, as smf(5)
				 * will kill us off.
				 */
				process.exit(1);
			}, 10 * 1000);
		});
		break;

	default:
		log.warn({
			message: msg
		}, 'received unexpected message');
		break;
	}
}


function
logset_queue_worker(t, next)
{
	if (!ready_for_workers()) {
		next();
		return;
	}

	var log = GS.gs_log.child({
		logset_name: t.t_logset_name
	});

	log.info('starting logset worker');

	var start = Date.now();
	t.t_logset_worker.run(function (err) {
		var runtime_ms = Date.now() - start;
		log.info({
			err: err,
			runtime_ms: runtime_ms
		}, 'finished logset worker');

		/*
		 * An individual logset should, under normal conditions, not
		 * take very long to enumerate and process.  If it takes more
		 * than 10 minutes, WARN so that we can potentially alarm on
		 * this condition.
		 */
		if (runtime_ms > (10 * 60 * 1000)) {
			log.warn({
				runtime_ms: runtime_ms
			}, 'logset worker ran for 10+ minutes');
		}

		next();
	});
}

function
start_worker(logset_name)
{
	/*
	 * Don't reschedule if we're already scheduled:
	 */
	if (GS.gs_worker.running[logset_name])
		return;

	/*
	 * Check that we still have a logset by this name, and load its
	 * configuration:
	 */
	var logset = lib_logsets.lookup_logset(logset_name);
	if (!logset)
		return;

	/*
	 * Set up a logset worker to do a log archival run:
	 */
	var lsw = new lib_worker.LogsetWorker({
		manta_user: GS.gs_manta.user,
		manta: GS.gs_manta.client,
		logset: logset,
		log: GS.gs_log.child({
			component: 'LogsetWorker',
			logset_name: logset_name
		}),
		datacenter: GS.gs_dcname,
		nodename: GS.gs_sysinfo['UUID'],
		mahi: GS.gs_mahi.client
	});

	/*
	 * Put the worker tracking object in the slot for this worker,
	 * so that we don't start another one for the same logset until
	 * this run is complete:
	 */
	GS.gs_worker.running[logset_name] = lsw;

	/*
	 * Put it on the run queue:
	 */
	GS.gs_worker.logset_queue.push({
		t_logset_name: logset_name,
		t_logset_worker: lsw
	}, function () {
		/*
		 * Once we return from processing, remove the tracking
		 * object from its slot so that this logset can be run again
		 * later:
		 */
		delete GS.gs_worker.running[logset_name];
	});
}

function
start_log_workers()
{
	if (!ready_for_workers())
		return (false);

	var logsets = lib_logsets.list_logsets();
	for (var i = 0; i < logsets.length; i++) {
		start_worker(logsets[i]);
	}
}

function
cancel_log_workers()
{
	GS.gs_worker.enabled = false;

	for (var k in GS.gs_worker.running) {
		if (!GS.gs_worker.running.hasOwnProperty(k))
			continue;

		if (!GS.gs_worker.running[k])
			continue;

		GS.gs_log.info({
			logset_name: k
		}, 'cancelling worker');

		/*
		 * We call destroy() on this logset, which will cause the
		 * inflight processing run to end as soon as possible.
		 */
		GS.gs_worker.running[k].destroy();
	}
}

function
resched()
{
	var dt = new Date();
	dt.setUTCMilliseconds(0);

	/*
	 * Advance to the bottom half of the next minute:
	 */
	do {
		dt.setUTCSeconds(dt.getUTCSeconds() + 1);
	} while (dt.getUTCSeconds() !== 30);

	if (GS.gs_worker.timeout) {
		clearTimeout(GS.gs_worker.timeout);
	}
	GS.gs_worker.timeout = setTimeout(function () {
		GS.gs_worker.timeout = null;
		start_log_workers();
		resched();
	}, dt.valueOf() - Date.now());
}

function
main()
{
	var service_name = GS.gs_sfmri.split('/').reverse()[0];
	lib_utils.create_logger(GS, service_name);

	mod_vasync.pipeline({
		funcs: [
			get_deployed_version,
			get_sysinfo,
			get_server
		]
	}, function (err) {
		if (err) {
			GS.gs_log.fatal({
				err: err
			}, 'fatal error while starting up');
			process.exit(1);
		}

		GS.gs_log.info({
			deployed_version: GS.gs_deployed_version,
			server_address: GS.gs_server_address
		}, 'configuration');

		/*
		 * In order to run a fixed number of upload workers
		 * simultaneously, we push instances of LogsetWorker through
		 * this queue.  If the logset worker for a particular logset is
		 * still running, we do not push another into the queue.
		 */
		GS.gs_worker.logset_queue = mod_vasync.queuev({
			worker: logset_queue_worker,
			concurrency: 4
		});

		/*
		 * Begin connecting to server:
		 */
		setup_connection();

		/*
		 * Kick off periodic worker:
		 */
		resched();
	});
}

main();

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
