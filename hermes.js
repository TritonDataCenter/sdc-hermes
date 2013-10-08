#!/usr/bin/env node
/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');
var mod_http = require('http');
var mod_assert = require('assert');
var mod_util = require('util');
var mod_os = require('os');

var mod_sdc = require('sdc-clients');
var mod_manta = require('manta');
var mod_uuid = require('libuuid');
var mod_vasync = require('vasync');
var mod_bunyan = require('bunyan');
var mod_kang = require('kang');

var mod_logsets = require('./lib/logsets');
var mod_utils = require('./lib/utils');
var mod_inflight = require('./lib/inflight');
var mod_httpserver = require('./lib/httpserver');
var mod_mq = require('./lib/mq');
var mod_zones = require('./lib/zones');

var LOG = mod_bunyan.createLogger({
	name: 'uplog',
	level: process.env.LOG_LEVEL || mod_bunyan.INFO,
	serializers: {
		logfile: logfile_serialiser,
		err: mod_bunyan.stdSerializers.err
	}
});

process.on('uncaughtException', function (err) {
	LOG.fatal({ err: err }, 'UNCAUGHT EXCEPTION');
	throw (err);
});

var CONFIG = JSON.parse(mod_fs.readFileSync(mod_path.join(__dirname, 'etc',
    'config.json'), 'utf8'));

var KANG;
var MANTA;

var INFLIGHTS = new mod_inflight.InflightRegister();

var RABBIT_CONFIG = CONFIG.rabbitmq.split(':');
var URCONN = new mod_mq.URConnection(LOG, INFLIGHTS, {
	login: RABBIT_CONFIG[0],
	password: RABBIT_CONFIG[1],
	host: RABBIT_CONFIG[2],
	port: RABBIT_CONFIG[3]
});
URCONN.on('server_info', function (server_info) {
	LOG.info({
		server_info: server_info
	}, 'received server info');
	server_update(server_info.server, server_info.datacenter);
});

var ZONES = new mod_zones.ZoneList(LOG, CONFIG.sapi.url,
    CONFIG.vmapi.url, "sdc");

var PORT;
var HTTPSERVER;

function
logfile_serialiser(lf)
{
	return ({
		server: lf.lf_server.s_uuid,
		zonename: lf.lf_zonename,
		zonerole: lf.lf_zonerole,
		datacenter: lf.lf_server.s_datacenter,
		local_path: lf.lf_logpath,
		manta_path: lf.lf_mantapath,
		uploaded: lf.lf_uploaded,
		removed: lf.lf_removed,
		generation: lf.lf_generation
	});
}


var SCRIPTS = {};


/*
 * Server and Logfile Management Functions:
 */
var SERVERS = [];

function
server_list()
{
	return (SERVERS.map(function (server) {
		return (server.s_uuid);
	}));
}

function
server_lookup(server)
{
	for (var i = 0; i < SERVERS.length; i++) {
		var s = SERVERS[i];

		if (s.s_uuid === server)
			return (s);
	}

	return (null);
}

function
server_update(server_uuid, dcname)
{
	var s = server_lookup(server_uuid);

	if (!s) {
		s = {
			s_uuid: server_uuid,
			s_datacenter: dcname,
			s_lastseen: Math.floor(Date.now() / 1000),
			s_lastenum: null,
			s_discoverid: null,
			s_logfiles: [],
			s_generation: 1,
			s_worker_running: false
		};
		SERVERS.push(s);
	} else {
		s.s_lastseen = Math.floor(Date.now() / 1000);
	}

	return (s);
}

function
logfile_lookup(server, zonename, logpath)
{
	for (var i = 0; i < server.s_logfiles.length; i++) {
		var lf = server.s_logfiles[i];
		if (lf.lf_zonename === zonename &&
		    lf.lf_logpath === logpath) {
			return (lf);
		}
	}

	return (null);
}

function
logfile_update(s, logpath, zonename, zonerole)
{
	var logset = mod_logsets.lookup_logset(logpath);

	if (!logset) {
		console.log('could not find logset for %s:%s', zonename,
		    logpath);
		process.abort();
	}

	/*
	 * Find log file by path, if it exists already:
	 */
	var lf = logfile_lookup(s, zonename, logpath);

	/*
	 * If it does not, then add it:
	 */
	if (!lf) {
		lf = {
			lf_server: s,
			lf_zonename: zonename,
			lf_zonerole: zonerole,
			lf_logpath: logpath,
			lf_mantapath: mod_logsets.local_to_manta_path(logset,
			    logpath, s.s_datacenter, zonename, s.s_uuid),
			lf_uploaded: false,
			lf_generation: s.s_generation,
			lf_md5: null
		};
		LOG.info({
			logfile: lf
		}, 'added new logfile');
		s.s_logfiles.push(lf);

		/*
		 * Schedule log upload worker if not already running:
		 */
		server_upload_worker(s);
	} else {
		/*
		 * Otherwise, update its generation number to reflect its
		 * visibility in the last discovery of this server:
		 */
		lf.lf_generation = s.s_generation;
		lf.lf_removed = false;
	}
}

/*
 * Prune log files determined to be absent, based on the generation number of
 * the last discovery sweep of this server:
 */
function
server_prune_logfiles(s)
{
	s.s_logfiles = s.s_logfiles.filter(function (lf) {
		var still_here = (lf.lf_generation === s.s_generation);
		if (!still_here) {
			/*
			 * TODO emit event for log files that no longer
			 * exist?
			 */
			LOG.info({
				logfile: lf
			}, 'log file disappeared');
		}
		return (still_here);
	});
}

/*
 * The Worker (and supporting subtasks) that uploads, and subsequently removes,
 * log files from hosts:
 */
function
server_upload_worker(s)
{
	if (s.s_worker_running)
		return;
	s.s_worker_running = true;

	/*
	 * Upload the first log file that isn't uploaded:
	 */
	for (var i = 0; i < s.s_logfiles.length; i++) {
		var lf = s.s_logfiles[i];

		if (!lf.lf_uploaded || !lf.lf_removed) {
			var pl = mod_vasync.pipeline({
				funcs: [
					worker_check_manta,
					worker_manta_mkdirp,
					worker_manta_upload,
					worker_remove_log
				],
				arg: lf
			}, function (err) {
				if (err) {
					LOG.error({
						err: err,
						logfile: lf
					}, 'logfile upload error');
					s.s_worker_running = false;
					setTimeout(function () {
						server_upload_worker(s);
					}, 1000);
				} else {
					LOG.debug({
						logfile: lf
					}, 'logfile finished processing');
					s.s_worker_running = false;
					setImmediate(function () {
						server_upload_worker(s);
					});
				}
			});
			/*
			 * Return now; we'll be rescheduled when the pipeline
			 * completes.
			 */
			return;
		}
	}

	/*
	 * If we fall out of the end of the list, then go back
	 * to sleep...
	 */
	s.s_worker_running = false;
}

function
worker_check_manta(lf, next)
{
	if (lf.lf_uploaded) {
		next();
		return;
	}

	MANTA.info(lf.lf_mantapath, {}, function (err, info) {
		if (err) {
			/*
			 * If we can't see the log in Manta, that's not
			 * an error per se.
			 */
			if (err.name !== 'NotFoundError')
				next(err);
			else
				next();
			return;
		} 

		/*
		 * We found the log file in Manta already; mark it
		 * uploaded:
		 */
		lf.lf_uploaded = true;
		lf.lf_md5 = info.md5;

		next();
	});
}

function
worker_manta_mkdirp(lf, next)
{
	if (lf.lf_uploaded) {
		next();
		return;
	}

	var dir = mod_path.dirname(lf.lf_mantapath);

	MANTA.mkdirp(dir, {}, next);
}

function
worker_manta_upload(lf, next)
{
	if (lf.lf_uploaded) {
		next();
		return;
	}

	var args = [
		lf.lf_logpath,
		'http://' + CONFIG.admin_ip + ':' + PORT + '/pushlog/%%ID%%',
		lf.lf_zonename
	];
	var data = {
		logfile: lf,
		barrier: mod_vasync.barrier()
	};

	var infl = URCONN.send_command(lf.lf_server.s_uuid, SCRIPTS.pushlog,
	    args, data);
	if (!infl) {
		next(new Error('URCONN could not send command at this time'));
		return;
	}

	var errors = [];
	data.barrier.on('drain', function () {
		infl.complete();
		next(errors[0] || errors[1]);
	});
	data.barrier.start('command_reply');
	data.barrier.start('http_put');

	infl.once('command_reply', function (reply) {
		LOG.debug({
			reply: reply
		}, 'push_log command reply');
		if (reply.exit_status !== 0) {
			errors[1] = new Error('pushlog exited ' +
			    reply.exit_status + ': ' + reply.stderr);
		}
		data.barrier.done('command_reply');
	});
	infl.once('http_put', function (req, res, _next) {
		LOG.debug({
			remoteAddress: req.socket.remoteAddress,
			remotePort: req.socket.remotePort,
			inflight_id: infl.id(),
			method: req.method,
			url: req.url
		}, 'http request');

		var opts = {
			md5: req.headers['content-md5'],
			contentLength: req.headers['content-length'],
			headers: {
				'if-match': '""'
			}
		};
		MANTA.put(lf.lf_mantapath, req, opts, function (_err, _res) {
			if (_err) {
				errors[0] = _err;
				res.send(500);
			} else {
				/*
				 * Mark the file as uploaded:
				 */
				lf.lf_uploaded = true;
				lf.lf_md5 = req.headers['content-md5'];

				LOG.info({
					mantapath: lf.lf_mantapath,
					md5: lf.lf_md5
				}, 'uploaded ok');
				res.send(200);
			}
			data.barrier.done('http_put');
			_next();
		});
	});
}

function
worker_remove_log(lf, next)
{
	/*
	 * Only remove log files if they have been uploaded:
	 */
	if (!lf.lf_uploaded || lf.lf_removed) {
		next();
		return;
	}

	var args = [
		lf.lf_logpath,
		lf.lf_md5,
		lf.lf_zonename
	];

	var infl = URCONN.send_command(lf.lf_server.s_uuid, SCRIPTS.removelog,
	    args, {});
	if (!infl) {
		next(new Error('URCONN could not send command at this time'));
		return;
	}

	infl.once('command_reply', function (reply) {
		infl.complete();

		if (reply.exit_status !== 0) {
			next(new Error('removelog exited ' + reply.exit_status +
			    ': ' + reply.stderr));
			return;
		}

		LOG.info({
			server: lf.lf_server.s_uuid,
			zonename: lf.lf_zonename,
			logpath: lf.lf_logpath,
		}, 'removed ok');
		lf.lf_removed = true;
		next();
		return;
	});
}

/*
 * The log file discovery functions:
 */
function
discover_logs_one(server)
{
	var zones = ZONES.get_zones_for_server(server.s_uuid);
	var script = SCRIPTS.enumlog.replace(/%%LOGSETS%%/,
	    mod_logsets.format_logsets_for_discovery(zones));

	var infl = URCONN.send_command(server.s_uuid, script, [], {});
	if (!infl) {
		LOG.warn('URCONN.send_command() returned false');
		return;
	}

	infl.once('command_reply', function (reply) {
		infl.complete();

		if (reply.exit_status !== 0) {
			LOG.error({
				stderr: reply.stderr
			}, 'log discovery command did not exit 0');
			return;
		}

		var obj;
		try {
			obj = JSON.parse(reply.stdout);
		} catch (_err) {
			LOG.error({
				err: _err
			}, 'could not parse JSON from log discovery');
			return;
		}

		server.s_generation++;
		for (var i = 0; i < obj.length; i++) {
			logfile_update(server, obj[i].path, obj[i].zonename,
			    obj[i].zonerole);
		}
		server_prune_logfiles(server);
	});
}

function
discover_logs_all()
{
	for (var i = 0; i < SERVERS.length; i++) {
		var s = SERVERS[i];

		LOG.info({
			server: s.s_uuid
		}, 'send discovery');
		discover_logs_one(s);
	}
}

/*
 * The server discovery function:
 */
function
send_sysinfo()
{
	URCONN.send_sysinfo_broadcast();
}

/*
 * Various Utilities:
 */
function
create_manta_client()
{
	MANTA_USER = process.env.MANTA_USER;
	if (!MANTA_USER) {
		throw (new Error('Please set MANTA_USER'));
	}

	var url = process.env.MANTA_URL;
	if (!url) {
		throw (new Error('Please set MANTA_URL'));
	}

	var key_id = process.env.MANTA_KEY_ID;
	if (!key_id) {
		throw (new Error('Please set MANTA_KEY_ID'));
	}

	var key_file = mod_path.join(process.env.HOME, '.ssh', 'sdc.id_rsa');

	var client = mod_manta.createClient({
		sign: mod_manta.privateKeySigner({
			key: mod_fs.readFileSync(key_file, 'utf8'),
			keyId: key_id,
			user: MANTA_USER
		}),
		user: MANTA_USER,
		url: url
	});

	MANTA = client;
}

function
load_scripts()
{
	var script_root = mod_path.join(__dirname, 'scripts');
	var ents = mod_fs.readdirSync(script_root);
	for (var i = 0; i < ents.length; i++) {
		var ent = ents[i];

		var scriptname = ent.replace(/\..*/, '');
		var script = mod_fs.readFileSync(mod_path.join(script_root,
		    ent), 'utf8');

		mod_assert.ok(!SCRIPTS[scriptname]);
		SCRIPTS[scriptname] = script;
	}
}

function
setup_kang()
{
	function list_types() {
		return ([
			'servers',
			'inflights'
		]);
	}

	function list_objects(type) {
		switch (type) {
		case 'servers':
			return (SERVERS.map(function (s) {
				return (s.s_uuid);
			}));
		case 'inflights':
			return (INFLIGHTS.dump_ids());
		default:
			throw (new Error('kang: dont know type ' + type));
		}
	}

	function get_object(type, id) {
		switch (type) {
		case 'inflights':
			return (INFLIGHTS.dump_one(id));
		case 'servers':
			var s = server_lookup(id);
			return ({
				uuid: s.s_uuid,
				outstanding: s.s_logfiles.map(
				    logfile_serialiser)
			});
		default:
			throw (new Error('kang: ' + id + ' of ' + type +
			    'not found'));
		}
	}

	var args = {
		uri_base: '/kang',
		port: 8492,
		version: '0.0.0',
		service_name: 'uplog_kang',
		ident: mod_os.hostname(),
		list_types: list_types,
		list_objects: list_objects,
		get: get_object
	};

	mod_kang.knStartServer(args, function (err, server) {
		if (err)
			throw (err);
		KANG = server;
	});
}

/*
 * Initialisation:
 */
LOG.info('loading scripts');
load_scripts();
LOG.info({ scripts: Object.keys(SCRIPTS) }, 'scripts');

LOG.info('creating manta client');
create_manta_client();

LOG.info('starting http server');
mod_httpserver.create_http_server(MANTA, INFLIGHTS, CONFIG.admin_ip, LOG,
    function (server) {
	HTTPSERVER = server;
	PORT = server.address().port;
});

setup_kang();

setInterval(send_sysinfo, CONFIG.polling.sysinfo * 1000);
setImmediate(send_sysinfo);

setInterval(discover_logs_all, CONFIG.polling.discovery * 1000);
setTimeout(discover_logs_all, 15 * 1000);

