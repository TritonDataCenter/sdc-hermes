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

function
pad(num, len)
{
	var out = String(num);

	while (out.length < len)
		out = '0' + out;

	return (out);
}

function
get_field(logset, field, m)
{
	var ds = logset.date_string;
	if (!ds)
		return ('');

	if (ds.hasOwnProperty(field)) {
		var dsf = ds[field];

		if (dsf[0] === '$') {
			var val = +m[+dsf[1]];
			var len = (field === 'y' ? 4 : 2);
			return (pad(val, len));
		} else {
			throw (new Error('invalid date string selector ' +
			    dsf));
		}
	} else {
		switch (field) {
		case 'y':
			return ('2013');
		case 'm':
		case 'd':
			return ('01');
		case 'H':
		case 'M':
		case 'S':
			return ('00');
		default:
			throw (new Error('unknown date field ' + field));
		}
	}
}

function
get_offset(offstr)
{
	var pos = 0;
	var sign = 1;
	var numstr = '';

	if (offstr[pos] === '-') {
		sign = -1;
		pos++;
	}

	while (offstr[pos] >= '0' && offstr[pos] <= '9') {
		numstr += offstr[pos];
		pos++;
	}

	if (offstr[pos] === 'H')
		return (sign * Number(numstr) * 3600 * 1000);

	throw (new Error('invalid offset'));
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
 *   #y, #m, #d, #H, #M, #S
 *      --> UTC Date/Time from (possibly adjusted) date_string matches
 */
function
local_to_manta_path(logset, logpath, datacenter, zonename, nodename, zonerole)
{
	var m = logset.regex.exec(logpath);

	/*
	 * We may need to parse, and then adjust (especially backwards) the
	 * date in the log filename.  This allows us to cope with logadm
	 * rotation timestamps, which are for the _rotation_ time, rather than
	 * the beginning of the period in the log file.
	 */
	if (logset.date_string) {
		var instr = get_field(logset, 'y', m) + '-' +
		    get_field(logset, 'm', m) + '-' +
		    get_field(logset, 'd', m) + 'T' +
		    get_field(logset, 'H', m) + ':' +
		    get_field(logset, 'M', m) + ':' +
		    get_field(logset, 'S', m) + '.000Z';
		var indate = new Date(instr);

		if (logset.date_adjustment) {
			indate = new Date(indate.valueOf() + get_offset(
			    logset.date_adjustment));
		}
	}

	var out = '';
	var state = null;
	for (var i = 0; i < logset.manta_path.length; i++) {
		var c = logset.manta_path[i];
		switch (state) {
		case '#':
			switch (c) {
			case 'y':
				out += pad(indate.getUTCFullYear(), 4);
				state = null;
				break;
			case 'm':
				out += pad(indate.getUTCMonth() + 1, 2);
				state = null;
				break;
			case 'd':
				out += pad(indate.getUTCDate(), 2);
				state = null;
				break;
			case 'H':
				out += pad(indate.getUTCHours(), 2);
				state = null;
				break;
			case 'M':
				out += pad(indate.getUTCMinutes(), 2);
				state = null;
				break;
			case 'S':
				out += pad(indate.getUTCSeconds(), 2);
				state = null;
				break;
			default:
				throw (new Error('invalid # char: ' + c));
			}
			break;
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
			case '#':
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
