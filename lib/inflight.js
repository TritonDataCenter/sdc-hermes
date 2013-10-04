/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_events = require('events');
var mod_util = require('util');

var mod_assert = require('assert-plus');

var mod_utils = require('./utils'); 

function
InflightRegister()
{
	this.ir_inflights = [];
}

InflightRegister.prototype.lookup = function
lookup(id)
{
	for (var i = 0; i < this.ir_inflights.length; i++) {
		if (this.ir_inflights[i].if_id === id)
			return (this.ir_inflights[i]);
	}
	return (null);
};

InflightRegister.prototype._remove = function
_remove(id)
{
	for (var i = 0; i < this.ir_inflights.length; i++) {
		if (this.ir_inflights[i].if_id === id) {
			this.ir_inflights.splice(i, 1);
			return;
		}
	}
	throw (new Error('inflight ' + id + ' not in inflight list'));
};

InflightRegister.prototype.register = function
register(data)
{
	for (;;) {
		var id = mod_utils.request_id();
		var exist = this.lookup(id);
		if (exist)
			continue;

		var infl = new Inflight(this, id, data);
		this.ir_inflights.push(infl);
		return (infl);
	}
};

InflightRegister.prototype.dump_ids = function
dump_ids()
{
	return (this.ir_inflights.map(function (_if) {
		return (_if.if_id);
	}));
};

InflightRegister.prototype.dump_one = function
dump_one(id)
{
	var infl = this.lookup(id);
	if (!infl)
		return (null);

	var now = Math.floor(+Date.now() / 1000);
	return ({
		id: infl.if_id,
		create_time: infl.if_ctime,
		age: now - infl.if_ctime
	});
};

function
Inflight(register, id, data)
{
	mod_assert.object(register);
	mod_assert.string(id);
	mod_assert.ok(data);

	this.if_register = register;
	this.if_id = id;
	this.if_data = data;

	this.if_ctime = Math.floor(+Date.now() / 1000);

	this.if_complete = false;

	mod_events.EventEmitter.call(this);
}
mod_util.inherits(Inflight, mod_events.EventEmitter);

Inflight.prototype.id = function
id()
{
	return (this.if_id);
};

Inflight.prototype.complete = function
complete()
{
	mod_assert.strictEqual(this.if_complete, false,
	    'inflight complete already');

	this.if_complete = true;
	this.if_register._remove(this.if_id);

	this.emit.apply(this, [ 'complete' ].concat(arguments));
};

Inflight.prototype.data = function
data()
{
	return (this.if_data);
};

module.exports = {
	InflightRegister: InflightRegister
};
