/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_http = require('http');
var mod_url = require('url');
var mod_net = require('net');
var mod_cueball = require('cueball');

function
BackendList(options)
{
	var self = this;

	mod_assert.object(options, 'options');
	mod_assert.object(options.log, 'log');
	mod_assert.string(options.hostname, 'hostname');
	mod_assert.number(options.port, 'port');

	self.bl_log = options.log;

	self.bl_hostname = options.hostname;
	self.bl_port = options.port;

	self.bl_backends = [];
	self.bl_last_backend = 0;

	self.bl_resolver = new mod_cueball.Resolver({
		log: self.bl_log,

		domain: self.bl_hostname,
		defaultPort: self.bl_port,

		recovery: {
			default: {
				timeout: 6000,
				retries: 3,
				delay: 250,
				maxDelay: 2500
			}
		}
	});
	self.bl_resolver.on('added', self._add_resolver.bind(self));
	self.bl_resolver.on('removed', self._remove_resolver.bind(self));

	self.bl_resolver.start();
}

BackendList.prototype._lookup_key = function
_lookup_key(key)
{
	var self = this;

	for (var i = 0; i < self.bl_backends.length; i++) {
		var be = self.bl_backends[i];

		if (be.be_keys.indexOf(key) !== -1)
			return (be);
	}

	return (null);
};

BackendList.prototype._add_resolver = function
_add_resolver(key, backend)
{
	var self = this;

	/*
	 * Check if an existing backend has this hostname/address
	 * pair:
	 */
	var be = self.lookup(backend.name, backend.address);

	if (be === null) {
		self.bl_log.info('resolver added backend: ' +
		    backend.address);

		/*
		 * No backend exists, so create a new one:
		 */
		self.bl_backends.push({
			be_keys: [ key ],
			be_name: backend.name,
			be_ip: backend.address,
			be_port: backend.port,

			be_birth_time: Date.now(),
			be_last_update: null,
			be_death_time: null,

			be_healthy: true,
			be_active: true,

			be_stats: {
				connections: 0,
				bytes_sent: 0,
				bytes_received: 0
			}
		});
		return;
	}

	/*
	 * The backend exists already, but may have a different key.
	 * Merge in the new key:
	 */
	if (be.be_keys.indexOf(key) === -1) {
		be.be_keys.push(key);
	}

	be.be_last_update = Date.now();
	be.be_healthy = true;
	be.be_active = true;
};

BackendList.prototype._remove_resolver = function
_remove_resolver(key)
{
	var self = this;

	var be = self._lookup_key(key);

	if (be === null) {
		return;
	}

	/*
	 * Remove the key from the list for this backend.
	 */
	var idx = be.be_keys.indexOf(key);
	be.be_keys.splice(idx, 1);

	if (be.be_keys.length > 0) {
		return;
	}

	self.be_log.info('resolver removed backend: ' + be.be_ip);

	be.be_death_time = Date.now();
	be.be_active = false;
};

BackendList.prototype.lookup = function
lookup(name, ip)
{
	var self = this;

	for (var i = 0; i < self.bl_backends.length; i++) {
		var be = self.bl_backends[i];

		if (be.be_name === name && be.be_ip === ip)
			return (be);
	}

	return (null);
};

BackendList.prototype.next = function
next(name)
{
	var self = this;

	var tries = 0;
	while (tries++ < self.bl_backends.length) {
		self.bl_last_backend = (self.bl_last_backend + 1) %
		    self.bl_backends.length;
		var be = self.bl_backends[self.bl_last_backend];

		if (be.be_name !== name)
			continue;

		if (be.be_keys.length < 1)
			continue;

		return (be);
	}

	return (null);
};

function
ProxyServer(opts)
{
	var self = this;

	mod_assert.object(opts, 'opts');
	mod_assert.object(opts.log, 'opts.log');
	mod_assert.number(opts.bind_port, 'opts.bind_port');
	mod_assert.optionalString(opts.bind_ip, 'opts.bind_ip');
	mod_assert.string(opts.backend_host, 'opts.backend_host');
	mod_assert.number(opts.backend_port, 'opts.backend_port');
	mod_assert.optionalFunc(opts.authfunc, 'opts.authfunc');

	self.px_log = opts.log;

	self.px_port = opts.bind_port;
	self.px_ip = opts.bind_ip;

	self.px_backend_host = opts.backend_host;
	self.px_backend_port = opts.backend_port;

	self.px_backends = new BackendList({
		log: opts.log.child({
			component: 'ProxyServerBackendList'
		}),
		hostname: opts.backend_host,
		port: opts.backend_port
	});

	self.px_server = mod_http.createServer();
	self.px_server.on('connect', self._on_connect.bind(self));

	self.px_connect_timeout = 5 * 1000;
	self.px_socket_timeout = 45 * 1000;
	self.px_keep_alive = 8 * 1000;

	self.px_authfunc = opts.authfunc || function (_, cb) {
		setImmediate(function () {
			cb(true);
		});
	};

	self._init();
}

ProxyServer.prototype._init = function
_init()
{
	var self = this;

	self.px_server.listen(self.px_port, self.px_ip || '0.0.0.0');
};

ProxyServer.prototype._make_conn = function
_make_conn(name, port, callback)
{
	var self = this;

	var be = self.px_backends.next(name);
	if (!be) {
		self.px_log.error('no backends available');
		callback(new Error('no backends available'));
		return;
	}

	var log = self.px_log.child({
		remote: be.be_ip + ':' + be.be_port
	});

	var conn = mod_net.createConnection(be.be_port, be.be_ip);
	conn.setKeepAlive(true, self.px_keep_alive);
	conn.setTimeout(self.px_socket_timeout);

	var to = setTimeout(function () {
		be.be_healthy = false;
		log.warn('timed out; trying next peer');

		conn.destroy();

		/*
		 * Try another peer:
		 */
		self._make_conn(name, port, callback);
	}, self.px_connect_timeout);

	conn.on('timeout', function () {
		log.warn('socket timeout; destroying');
		conn.destroy();
	});
	conn.on('error', function (err) {
		log.warn({
			err: err
		}, 'connection error');
		conn.removeAllListeners();

		/*
		 * Try another peer:
		 */
		self._make_conn(name, port, callback);
	});
	conn.on('close', function (had_error) {
		log.debug({
			had_error: had_error
		}, 'connection closed');
		be.be_stats.bytes_received += conn.bytesRead;
		be.be_stats.bytes_sent += conn.bytesWritten;
	});

	conn.on('connect', function () {
		clearTimeout(to);
		conn.removeAllListeners('error');
		be.be_stats.connections++;
		callback(null, conn, be);
	});
};

function
make_response(version, statusCode, message)
{
	mod_assert.string(version);
	mod_assert.number(statusCode);
	mod_assert.string(message);
	mod_assert.ok(version === '1.1' || version === '1.0');

	return ([
		'HTTP/' + version + ' ' + statusCode + ' ' + message,
		'',
		''
	].join('\r\n'));
}

ProxyServer.prototype._on_connect = function
_on_connect(req, socket, head)
{
	var self = this;

	var ok = false;

	var url = mod_url.parse('connect://' + req.url);

	var dest_host = url.hostname;
	var dest_port = Number(url.port || -1);
	mod_assert.ok(dest_port > 0);

	if (url.protocol === 'connect:' &&
	    dest_host === self.px_backend_host &&
	    dest_port === self.px_backend_port) {
		ok = true;
	}

	self.px_log.info({
		dest_host: dest_host,
		dest_port: dest_port,
		req: req,
		ok: ok
	}, 'connect');

	if (!ok) {
		socket.write(make_response(req.httpVersion, 400,
		    'Bad Request'));
		socket.end();
		return;
	}

	self.px_authfunc(req.headers.authorization, function (allow) {
		if (!allow) {
			self.px_log.info({
				req: req
			}, 'client authentication failed');
			socket.write(make_response(req.httpVersion, 407,
			    'Proxy Authentication Required'));
			socket.end();
			return;
		}

		self._after_auth(req, socket, head, dest_host, dest_port);
	});
};

ProxyServer.prototype._after_auth = function
_after_auth(req, socket, head, dest_host, dest_port)
{
	var self = this;

	var start = Date.now();
	self._make_conn(dest_host, dest_port, function (err, conn, backend) {
		if (err) {
			socket.write(make_response(req.httpVersion,
			    500, 'Error'));
			socket.end();
			return;
		}

		var log = self.px_log.child({
			server: conn.remoteAddress + ':' + conn.remotePort,
			client: socket.remoteAddress + ':' + socket.remotePort
		});

		socket.write(make_response(req.httpVersion, 200,
		    'Connection Established'));

		conn.write(head);
		conn.pipe(socket);
		socket.pipe(conn);

		var rem = 2;

		var fin = function () {
			if (--rem !== 0)
				return;
			log.info({
				lifetime_ms: Date.now() - start,
				bytes_sent: conn.bytesWritten,
				bytes_received: conn.bytesRead
			}, 'connection ended');
		};

		conn.on('close', function () {
			log.debug('server-side socket close');
			fin();
		});
		socket.on('close', function () {
			log.debug('client-side socket close');
			fin();
		});

		conn.on('error', function (_err) {
			log.info({
				err: _err
			}, 'client-side socket error');
		});
		socket.on('error', function (_err) {
			log.info({
				err: _err
			}, 'server-side socket error');
		});
	});
};

module.exports = {
	BackendList: BackendList,
	ProxyServer: ProxyServer
};

/* vim: set ts=8 sts=8 sw=8 noet: */
