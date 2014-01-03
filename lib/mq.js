/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_events = require('events');
var mod_util = require('util');
var mod_path = require('path');
var mod_child = require('child_process');

var mod_assert = require('assert-plus');
var mod_uuid = require('libuuid');

var mod_utils = require('./utils'); 

var QUEUE_BINDINGS = [
	'ur.execute-reply.*.*',
	'ur.startup.*'
];

function
URConnection(log, inflights, amqp_config)
{
	var self = this;
	mod_events.EventEmitter.call(this);

	mod_assert.object(log);
	mod_assert.object(inflights);
	mod_assert.object(amqp_config);

	this.urc_log = log;
	this.urc_inflights = inflights;

	mod_assert.string(amqp_config.login);
	mod_assert.string(amqp_config.password);
	mod_assert.string(amqp_config.host);
	mod_assert.string(amqp_config.port);
	this.urc_amqp_config = amqp_config;

	this.urc_child_timeout = null;
	this.urc_child = null;
	this.urc_child_ready = false;

	/*
	 * Register a persistent Inflight which we will use for
	 * all sysinfo broadcast replies:
	 */
	this.urc_sysinfo_inflight = inflights.register({
		name: 'long-term sysinfo inflight',
		toString: function () {
			return ('long-term sysinfo inflight');
		}
	});
	this.urc_sysinfo_inflight.on('command_reply', function (reply) {
		var server_info = {
			server: reply['UUID'],
			datacenter: reply['Datacenter Name'],
			setup: (reply['Setup'] === true ||
			    reply['Setup'] === 'true')
		};
		self.urc_log.trace({
			server_info: server_info
		}, 'sysinfo response');
		if (server_info.setup) {
			self.emit('server_info', server_info);
		}
	});

	process.on('exit', function __process_on_exit() {
		/*
		 * If we're exiting, try and kill our child process:
		 */
		if (self.urc_child)
			self.urc_child.kill();
	});

	setImmediate(function () {
		self._fork();
	});
}
mod_util.inherits(URConnection, mod_events.EventEmitter);

URConnection.prototype._from_child = function
_from_child(message)
{
	var self = this;

	switch (message.type) {
	case 'error':
		self.urc_log.error({
			message: message
		}, 'error in amqp child process');
		self.urc_child_ready = false;
		self.urc_child.kill();
		return;

	case 'ready':
		self.urc_log.info('amqp child process ready');
		self.urc_child_ready = true;
		if (self.urc_child_timeout) {
			clearTimeout(self.urc_child_timeout);
			self.urc_child_timeout = null;
		}
		return;

	case 'message':
		self._on_reply(message.message, message.headers,
		    message.delivery_info);
		return;

	default:
		self.urc_log.warn({
			message: message
		}, 'unknown message from amqp child process');
		return;
	}
};

URConnection.prototype._fork = function
_fork()
{
	var self = this;
	var script = mod_path.join(__dirname, 'mq_child.js');

	if (self.urc_child)
		return;

	/*
	 * Spawn the child process that will handle our AMQP connection:
	 */
	if (self.urc_child_timeout)
		clearTimeout(self.urc_child_timeout);
	self.urc_child_ready = false;
	self.urc_child = mod_child.fork(mod_path.join(__dirname,
	    'mq_child.js'));

	/*
	 * If the child process is not ready within thirty seconds, kill
	 * it and try again:
	 */
	self.urc_child_timeout = setTimeout(function () {
		self.urc_log.warn('amqp connection timeout; killing child');
		self.urc_child_ready = false;
		self.urc_child.kill();
	}, 30000);

	/*
	 * Listen for process end/error events:
	 */
	self.urc_child.once('error', function __on_error(err) {
		self.urc_log.error({
			err: err
		}, 'amqp child process error');
		_clear_and_reschedule();
	});
	self.urc_child.once('exit', function __on_exit(code, signal) {
		self.urc_log.info({
			code: code,
			signal: signal
		}, 'amqp child process exited');
		_clear_and_reschedule();
	});
	function _clear_and_reschedule() {
		self.urc_child = null;
		self.urc_child_ready = false;
		/*
		 * Schedule a reconnection soon:
		 */
		setTimeout(self._fork.bind(self), 10000);
	}

	/*
	 * Request that the child make an AMQP connection to the broker:
	 */
	self.urc_child.on('message', self._from_child.bind(self));
	self.urc_child.send({
		type: 'connect',
		amqp_config: self.urc_amqp_config,
		bindings: QUEUE_BINDINGS
	});
};

URConnection.prototype.ready = function
ready()
{
	return (this.urc_child && this.urc_child_ready);
};

URConnection.prototype._on_reply = function
_on_reply(msg, hdrs, dinfo)
{
	this.urc_log.trace({
		deliveryInfo: dinfo,
		headers: hdrs,
		message: msg
	}, '_on_reply()');

	var key = dinfo.routingKey.split('.');

	/*
	 * Ignore messages that are not UR execution replies:
	 */
	if (key[0] !== 'ur' || key[1] !== 'execute-reply') {
		this.urc_log.trace({
			deliveryInfo: dinfo,
			headers: hdrs,
			message: msg
		}, 'unknown delivery info in reply');
		return;
	}

	/*
	 * Handle other responses via the Inflights register:
	 */
	var request_id = key[3];
	var infl = this.urc_inflights.lookup(request_id);
	if (infl) {
		infl.emit('command_reply', msg);
	} else {
		this.urc_log.trace({
			deliveryInfo: dinfo,
			headers: hdrs,
			message: msg
		}, 'unknown delivery info in reply');
	}
};

URConnection.prototype.send_sysinfo_broadcast = function
send_sysinfo_broadcast()
{
	if (!this.ready())
		return;

	this.urc_log.debug({
		request_id: this.urc_sysinfo_inflight.id()
	}, 'send sysinfo broadcast');

	this.urc_child.send({
		type: 'publish',
		key: 'ur.broadcast.sysinfo.' +
		    this.urc_sysinfo_inflight.id(),
		message: {}
	});
};

URConnection.prototype.send_command = function
send_command(server_id, script, args, data) {
	if (!this.ready()) {
		return (null);
	}

	var infl = this.urc_inflights.register(data);

	var msg = {
		type: 'script',
		script: script,
		args: args.map(function (x) {
			return (x.replace(/%%ID%%/g, infl.id()));
		}),
		env: {}
	};
	this.urc_child.send({
		type: 'publish',
		key: 'ur.execute.' + server_id + '.' + infl.id(),
		message: msg
	});

	return (infl);
};

module.exports = {
	URConnection: URConnection
};
