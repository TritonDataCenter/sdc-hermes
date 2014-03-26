/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_assert = require('assert-plus');
var mod_http = require('http');
var mod_url = require('url');
var mod_net = require('net');
var mod_dns = require('native-dns');
var mod_vasync = require('vasync');

function
BackendList(log, hostname, port, nameservers)
{
	var self = this;

	self.bl_log = log;

	self.bl_hostname = hostname;
	self.bl_port = port;

	self.bl_dns_question = mod_dns.Question({
		name: self.bl_hostname,
		type: 'A'
	});
	self.bl_dns_nameservers = nameservers;

	self.bl_backends = [];
	self.bl_last_backend = 0;

	self.bl_worker_running = false;
	self.bl_worker_timeout = setTimeout(function () {
		self._dns_worker();
	}, 0);
}

BackendList.prototype._resolve = function
_resolve(name, callback)
{
	var self = this;

	self.bl_log.debug('resolving %s', name);

	var _resolve_worker = function _resolve_worker(nameserver, next) {
		var req = mod_dns.Request({
			question: self.bl_dns_question,
			server: nameserver,
			timeout: 4000,
			cache: false
		});
		var answer;
		var error;

		req.on('timeout', function () {
			error = new Error('dns request timeout');
			error.remoteAddress = nameserver.address;
			error.remotePort = nameserver.port;
			error.nameserver = nameserver;
		});

		req.on('message', function (_err, _answer) {
			self.bl_log.trace({
				nameserver: nameserver,
				err: _err,
				answer: _answer
			}, 'dns message');

			error = _err;
			answer = _answer;
		});

		req.on('end', function () {
			next(error, answer);
		});

		req.send();
	};

	mod_vasync.forEachParallel({
		func: _resolve_worker,
		inputs: self.bl_dns_nameservers
	}, function (err, results) {
		self.bl_log.trace({
			err: err,
			results: results
		}, 'DNS response!');

		if (results.successes.length === 0) {
			if (err) {
				callback(err);
			} else {
				callback(new Error('dns failure'));
			}
			return;
		}

		var out = [];
		var update_ip = function (ip, ttl) {
			ttl = Math.max(ttl || 60, 60);
			for (var k = 0; k < out.length; k++) {
				if (out[k].ip === ip) {
					out[k].ttl = Math.max(out[k].ttl,
					    ttl);
					return;
				}
			}
			out.push({
				ip: ip,
				ttl: ttl
			});
		};
		for (var i = 0; i < results.successes.length; i++) {
			var suc = results.successes[i];
			var atype = mod_dns.consts.NAME_TO_QTYPE.A;

			if (!suc.answer)
				continue;

			for (var j = 0; j < suc.answer.length; j++) {
				var rr = suc.answer[j];
				if (rr.name === name && rr.type === atype &&
				    mod_net.isIP(rr.address)) {
					update_ip(rr.address, rr.ttl);
				}
			}
		}

		callback(null, out);
	});
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
	var now = Date.now();

	var tries = 0;
	while (tries++ < self.bl_backends.length) {
		self.bl_last_backend = (self.bl_last_backend + 1) %
		    self.bl_backends.length;
		var be = self.bl_backends[self.bl_last_backend];

		if (be.be_name !== name)
			continue;

		if (be.be_valid_until < now)
			continue;

		return (be);
	}

	return (null);
};

BackendList.prototype._resched = function
_resched()
{
	var self = this;

	if (self.bl_worker_timeout)
		clearTimeout(self.bl_worker_timeout);

	self.bl_worker_timeout = setTimeout(function () {
		self._dns_worker();
	}, 30 * 1000);
};

BackendList.prototype._dns_worker = function
_dns_worker()
{
	var self = this;

	if (self.bl_worker_running)
		return;
	self.bl_worker_running = true;

	self._resolve(self.bl_hostname, function (err, res) {
		var i;
		var be;

		if (err) {
			self.bl_log.error({
				hostname_: self.bl_hostname,
				err: err
			}, 'dns lookup error');
			self.bl_worker_running = false;
			self._resched();
			return;
		}

		self.bl_log.debug({
			hosts: res
		}, 'dns response');

		var now = Date.now();

		for (i = 0; i < res.length; i++) {
			var rr = res[i];
			be = self.lookup(self.bl_hostname, rr.ip);

			if (!be) {
				be = {
					be_name: self.bl_hostname,
					be_ip: rr.ip,
					be_port: self.bl_port,
					be_valid_until: now + rr.ttl * 1000,
					be_active: true,
					be_healthy: true,
					be_reported_gone: false,
					be_stats: {
						connections: 0,
						bytes_sent: 0,
						bytes_received: 0
					}
				};
				self.bl_backends.push(be);
				self.bl_log.info({
					bename: be.be_name,
					backend: be.be_ip,
					ttl: (be.be_valid_until - now) / 1000
				}, 'new backend');
			} else {
				if (be.be_reported_gone) {
					self.bl_log.info({
						bename: be.be_name,
						backend: be.be_ip,
						ttl: (be.be_valid_until -
						    now) / 1000
					}, 'backend returned');
				}
				be.be_reported_gone = false;
				be.be_valid_until = now + rr.ttl * 1000;
				be.be_healthy = true;
			}
		}

		for (i = 0; i < self.bl_backends.length; i++) {
			be = self.bl_backends[i];

			if (be.be_valid_until < now) {
				if (!be.be_reported_gone) {
					self.bl_log.info({
						bename: be.be_name,
						backend: be.be_ip
					}, 'backend expired');
					be.be_reported_gone = true;
				}
			}
		}

		self.bl_worker_running = false;
		self._resched();
	});
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
	mod_assert.arrayOfObject(opts.nameservers, 'opts.nameservers');

	self.px_log = opts.log;

	self.px_port = opts.bind_port;
	self.px_ip = opts.bind_ip;

	self.px_backend_host = opts.backend_host;
	self.px_backend_port = opts.backend_port;

	self.px_backends = new BackendList(opts.log.child({
		component: 'ProxyServerBackendList'
	}), opts.backend_host, opts.backend_port, opts.nameservers);

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
