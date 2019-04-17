/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var mod_net = require('net');
var mod_fs = require('fs');
var mod_path = require('path');
var mod_assert = require('assert-plus');
var mod_util = require('util');
var mod_events = require('events');

var mod_restify = require('restify');
var mod_watershed = require('watershed');

var WATERSHED = new mod_watershed.Watershed();


function
HttpServer(log, ip, port, tarstamp, scriptmgr, agent_name)
{
	var self = this;
	mod_events.EventEmitter.call(self);

	mod_assert.object(log, 'log');
	mod_assert.ok(mod_net.isIP(ip), 'ip');
	mod_assert.number(port, 'port');
	mod_assert.string(tarstamp, 'tarstamp');
	mod_assert.object(scriptmgr, 'scriptmgr');
	mod_assert.string(agent_name, 'agent_name');

	self.hs_log = log;
	self.hs_ip = ip;
	self.hs_port = port;
	self.hs_tarstamp = tarstamp;
	self.hs_scriptmgr = scriptmgr;
	self.service_name = agent_name;

	setImmediate(function () {
		self._init();
	});
}
mod_util.inherits(HttpServer, mod_events.EventEmitter);

HttpServer.prototype._init = function
_init()
{
	var self = this;

	self.hs_server = mod_restify.createServer({
		name: 'hermes',
		log: self.hs_log,
		handleUpgrades: true,
		handleUncaughtExceptions: false
	});

	var attach = function (req, res, next) {
		if (!res.claimUpgrade) {
			req.log.warn({
				remote: req.connection.remoteAddress + ':' +
				    req.connection.remotePort
			}, 'client did not attempt upgrade');
			res.send(500);
			next(false);
			return;
		}

		var upgrade = res.claimUpgrade();
		upgrade.socket.setKeepAlive(true);

		var shed;
		try {
			shed = WATERSHED.accept(req, upgrade.socket, upgrade.head);
		} catch (ex) {
			req.log.error({
				err: ex
			}, 'watershed error');
			next(false);
			return;
		}

		mod_assert.ok(self.listeners('shed').length !== 0,
		    'shed listeners');
		self.emit('shed', shed);

		next(false);
	};

	var get_script = function (filename, req, res, next) {

		var script = self.hs_scriptmgr.load(filename, {
			ENDPOINT: self.hs_ip + ':' + self.hs_port,
			AGENT_NAME: self.agent_name,
			VERSION: self.hs_tarstamp,
			SMF_REVISION: 'HERMES-1'
		});

		res.writeHead(200);
		res.write(script);
		res.end();

		next();
	};

	var get_actor_tarball = function (req, res, next) {
		var path = mod_path.join(__dirname, '..', 'actor.tar.gz');
		var fs = mod_fs.createReadStream(path);

		fs.pipe(res);
		fs.on('end', next);
	};

	self.hs_server.get('/bootstrap.ksh', get_script.bind(null,
	    'bootstrap.ksh'));
	self.hs_server.get('/actor.ksh', get_script.bind(null, 'actor.ksh'));
	self.hs_server.get('/actor.xml', get_script.bind(null, 'actor.xml'));
	self.hs_server.get('/actor.tar.gz', get_actor_tarball);
	self.hs_server.get('/attach', attach);

	self.hs_server.listen(self.hs_port, self.hs_ip, function () {
		self.hs_log.info({
			address: self.hs_server.address()
		}, 'http server listening');
		self.emit('listening', self.hs_server.address());
	});
};

module.exports = {
	HttpServer: HttpServer
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
