/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_assert = require('assert-plus');
var mod_amqp = require('amqp');
var mod_uuid = require('libuuid');

var HANDLERS = {
	connect: handle_connect,
	publish: handle_publish
};

var STATE = 'INITIALISING';

var AMQP;
var EXCHANGE;
var QUEUE;

function
emit_error(err)
{
	if (STATE === 'ERROR')
		return;
	STATE = 'ERROR';

	process.send({
		type: 'error',
		error: err.message,
		stack: err.stack
	});
}

function
on_reply(msg, hdrs, dinfo)
{
	if (STATE === 'ERROR')
		return;

	process.send({
		type: 'message',
		message: msg,
		headers: hdrs,
		delivery_info: dinfo
	});
}

function
handle_publish(m, next)
{
	if (STATE === 'ERROR')
		return;
	mod_assert.strictEqual(STATE, 'READY');

	EXCHANGE.publish(m.key, m.message);
}

function
add_subscriptions(bindings, cb)
{
	if (STATE === 'ERROR')
		return;
	mod_assert.strictEqual(STATE, 'CONNECTED');

	EXCHANGE = AMQP.exchange('amq.topic', {
		type: 'topic'
	});

	QUEUE = AMQP.queue('ur.oneachnode.' + mod_uuid.create());
	QUEUE.on('open', function () {
		if (STATE === 'ERROR')
			return;
		mod_assert.strictEqual(STATE, 'CONNECTED');

		for (var i = 0; i < bindings.length; i++) {
			QUEUE.bind('amq.topic', bindings[i]);
		}

		QUEUE.subscribe(on_reply);

		STATE = 'READY';
		process.send({
			type: 'ready'
		});
	});
}

function
handle_connect(m)
{
	if (STATE === 'ERROR')
		return;
	mod_assert.strictEqual(STATE, 'INITIALISING');

	STATE = 'CONNECTING';

	AMQP = mod_amqp.createConnection(m.amqp_config, {
		defaultExchangeName: '',
		reconnect: false
	});

	AMQP.on('error', emit_error);

	AMQP.on('ready', function () {
		if (STATE === 'ERROR')
			return;

		mod_assert.strictEqual(STATE, 'CONNECTING');
		STATE = 'CONNECTED';

		add_subscriptions(m.bindings);
	});

	AMQP.on('close', function () {
		emit_error(new Error('connection closed'));
	});
}

function
handle_message(m)
{
	mod_assert.ok(m);

	mod_assert.strictEqual(typeof (m.type), 'string');

	var handler = HANDLERS[m.type];
	mod_assert.ok(handler);

	try {
		handler(m);
	} catch (ex) {
		emit_error(ex);
	}
}

process.on('message', handle_message);
