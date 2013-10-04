/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_events = require('events');
var mod_util = require('util');

var mod_assert = require('assert-plus');
var mod_amqp = require('amqp');
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

	this.urc_exchange = null;
	this.urc_queue = null;
	this.urc_ready = false;

	/*
	 * Register a persistent Inflight which we will use for
	 * all sysinfo broadcast replies:
	 */
	this.urc_sysinfo_inflight = inflights.register({});
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

	this.urc_amqp = mod_amqp.createConnection(this.urc_amqp_config);
	this.urc_amqp.on('error', function (err) {
		self.urc_log.error({
			err: err
		}, 'amqp error');
		mod_assert.ifError(err);
	});
	this.urc_amqp.on('ready', function () {
		self.urc_log.debug('amqp ready');

		mod_assert.ok(!self.urc_exchange);
		self.urc_exchange = self.urc_amqp.exchange('amq.topic', {
			type: 'topic'
		});

		mod_assert.ok(!self.urc_queue);
		self.urc_queue = self.urc_amqp.queue('ur.oneachnode.' +
		    mod_uuid.create());

		self.urc_queue.on('open', function () {
			self.urc_log.debug('amqp queue open');

			QUEUE_BINDINGS.forEach(function (qb) {
				self.urc_log.debug('amqp bind queue to ' + qb);
				self.urc_queue.bind('amq.topic', qb);
			});

			self.urc_queue.subscribe(function () {
				self._on_reply.apply(self, arguments);
			});

			self.urc_ready = true;

			self.urc_log.debug('amqp ready complete');
		});
	});
}
mod_util.inherits(URConnection, mod_events.EventEmitter);

URConnection.prototype.ready = function
ready()
{
	return (this.urc_ready);
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
	if (!this.urc_ready)
		return;

	this.urc_log.debug({
		request_id: this.urc_sysinfo_inflight.id()
	}, 'send sysinfo broadcast');

	this.urc_exchange.publish('ur.broadcast.sysinfo.' +
	    this.urc_sysinfo_inflight.id(), {});
};

URConnection.prototype.send_command = function
send_command(server_id, script, args, data) {
	if (!this.urc_ready) {
		return (null);
	}

	var infl = this.urc_inflights.register(data);

	this.urc_exchange.publish('ur.execute.' + server_id + '.' +
	    infl.id(), {
		type: 'script',
		script: script,
		args: args.map(function (x) {
			return (x.replace(/%%ID%%/g, infl.id()));
		}),
		env: {}
	});

	return (infl);
};

module.exports = {
	URConnection: URConnection
};
