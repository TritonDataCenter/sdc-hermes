#!/usr/bin/env node
/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');
var mod_http = require('http');
var mod_assert = require('assert');
var mod_util = require('util');

var mod_sdc = require('sdc-clients');
var mod_manta = require('manta');
var mod_uuid = require('libuuid');
var mod_vasync = require('vasync');
var mod_bunyan = require('bunyan');
var mod_restify = require('restify');

function
create_http_server(manta, inflights, ip, log, callback)
{
	var server = mod_restify.createServer({
		name: 'Uplogger',
		log: log
	});

	function lookup_inflight(req, res, next) {
		var inflight_id = req.params.reqid;
		if (!inflight_id) {
			next(new Error('need request id'));
			return;
		}

		req.inflight = inflights.lookup(inflight_id);
		if (!req.inflight) {
			next(new Error('could not find request ' +
			    inflight_id));
			return;
		}

		req.inflight.emit('http_put', req, res, next);
	}

	server.put('/pushlog/:reqid', lookup_inflight);

	server.listen(0, ip, function () {
		log.info({
			address: server.address()
		}, 'http server listening');
		callback(server);
	});
}

module.exports = {
	create_http_server: create_http_server
};
