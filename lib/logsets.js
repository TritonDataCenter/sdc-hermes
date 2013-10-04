#!/usr/bin/env node
/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');
var mod_assert = require('assert');

var LOGSETS;

function
load_logsets()
{
	LOGSETS = JSON.parse(mod_fs.readFileSync(mod_path.join(__dirname,
	    '..', 'etc', 'logsets.json'), 'utf8'));
	for (var i = 0; i < LOGSETS.length; i++) {
		var ls = LOGSETS[i];
		ls.regex = new RegExp(ls.regex);
	}
}

function
format_logsets_for_discovery(zone_list_for_server)
{
	var OUT = [];

	for (var i = 0; i < LOGSETS.length; i++) {
		var ls = LOGSETS[i];

		/*
		 * This logset applies to the global zone:
		 */
		if (ls.zones.indexOf("global") !== -1) {
			OUT.push({
				name: ls.name,
				search_dirs: ls.search_dirs,
				regex: ls.regex.source,
				debounce_time: ls.debounce_time || 600,
				zonename: 'global',
				zonerole: 'global'
			});
		}

		var matching_zones = [];
		for (var j = 0; j < zone_list_for_server.length; j++) {
			var zz = zone_list_for_server[j];
			if (ls.zones.indexOf(zz.role) !== -1) {
				OUT.push({
					name: ls.name,
					search_dirs: ls.search_dirs,
					regex: ls.regex.source,
					debounce_time: ls.debounce_time || 600,
					zonename: zz.uuid,
					zonerole: zz.role
				});
			}
		}
	}

	return (JSON.stringify(OUT));
}

/*
 * Substitute:
 *   %u --> $MANTA_USER
 *   %d --> Datacentre Name
 *   %z --> Zone Name
 *   %n --> Node Name (or Zone Name for a Zone)
 *   %r --> Zone Role (e.g. "workflow" or "adminui")
 *   $1, $2, etc
 *      --> Regex Group, i.e. match[1], match[2], etc
 */
function
local_to_manta_path(logset, logpath, datacenter, zonename, nodename, zonerole)
{
	var m = logset.regex.exec(logpath);

	var out = '';
	var state = null;
	for (var i = 0; i < logset.manta_path.length; i++) {
		var c = logset.manta_path[i];
		switch (state) {
		case '%':
			switch (c) {
			case '%':
				out += '%';
				state = null;
				break;
			case 'u':
				out += MANTA_USER;
				state = null;
				break;
			case 'r':
				out += zonerole;
				state = null;
				break;
			case 'd':
				out += datacenter;
				state = null;
				break;
			case 'z':
				out += zonename;
				state = null;
				break;
			case 'n':
				out += zonename === 'global' ? nodename :
				    zonename;
				state = null;
				break;
			default:
				throw (new Error('invalid % char: ' + c));
			}
			break;
		case '$':
			if (c === '$') {
				out += '$';
				state = null;
				break;
			}
			if (c >= '1' && c <= '9') {
				out += m[Number(c)];
				state = null;
				break;
			}
			throw (new Error('invalid % char: ' + c));
		default:
			switch (c) {
			case '%':
			case '$':
				state = c;
				break;
			default:
				out += c;
				break;
			}
		}
	}

	return (out);
}

function
lookup_logset(logpath)
{
	for (var i = 0; i < LOGSETS.length; i++) {
		if (LOGSETS[i].regex.test(logpath)) {
			return (LOGSETS[i]);
		}
	}

	return (null);
}

/*
 * Initialisation:
 */
load_logsets();

/*
 * API:
 */
module.exports = {
	lookup_logset: lookup_logset,
	local_to_manta_path: local_to_manta_path,
	format_logsets_for_discovery: format_logsets_for_discovery
};
