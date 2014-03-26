/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_crypto = require('crypto');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_once = require('once');

function
request_id()
{
	return (Math.floor(Math.random() * 0xffffffff).toString(16));
}

function
hash_file(path, callback)
{
	var hash = mod_crypto.createHash('sha1');
	var fin = mod_fs.createReadStream(path);

	callback = mod_once(callback);

	fin.on('readable', function () {
		var buf;
		while (!!(buf = fin.read())) {
			hash.update(buf);
		}
	});
	fin.on('end', function () {
		callback(null, hash.digest('hex'));
	});
	fin.on('error', callback);
}

function
create_logger(global_state, app_name)
{
	mod_assert.ok(!global_state.gs_ringbuf && !global_state.gs_log);

	global_state.gs_log = mod_bunyan.createLogger({
		name: app_name,
		serializers: mod_bunyan.stdSerializers,
		level: process.env.LOG_LEVEL || mod_bunyan.INFO
	});
}

module.exports = {
	request_id: request_id,
	hash_file: hash_file,
	create_logger: create_logger
};
