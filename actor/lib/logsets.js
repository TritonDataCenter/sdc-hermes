/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */


var LOGSETS;

/*
 * Unpack JSON-safe logsets into objects and replace current logsets:
 */
function
use_logsets(logsets)
{
	for (var i = 0; i < logsets.length; i++) {
		var ls = logsets[i];
		ls.regex = new RegExp(ls.regex);
	}
	LOGSETS = logsets;
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
			return ('0000');
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

function
parse_date(logset, logpath)
{
	var m = logset.regex.exec(logpath);

	if (logset.date_string) {
		var instr = get_field(logset, 'y', m) + '-' +
		    get_field(logset, 'm', m) + '-' +
		    get_field(logset, 'd', m) + 'T' +
		    get_field(logset, 'H', m) + ':' +
		    get_field(logset, 'M', m) + ':' +
		    get_field(logset, 'S', m) + '.000Z';

		return (new Date(instr));
	}

	return (null);
}

function
uuid_to_account(logset, logpath, mahi, callback)
{
	var m = logset.regex.exec(logpath);

	if (!logset.customer_uuid) {
		callback();
		return;
	}

	var position = logset.customer_uuid.slice(1);
	var customer_uuid = m[position];

	mahi.getAccountById(customer_uuid, function onAccount(err, response) {
		if (err) {
		    callback(err);
		    return;
		}

		callback(null, response.account.login);
	});
}

/*
 * Substitute:
 *   %u --> Manta User
 *   %U --> Manta Customer Username
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
local_to_manta_path(manta_user, logset, logpath, datacenter, nodename, customer)
{
	var m = logset.regex.exec(logpath);
	var indate = parse_date(logset, logpath);

	/*
	 * We may need to parse, and then adjust (especially backwards) the
	 * date in the log filename.  This allows us to cope with logadm
	 * rotation timestamps, which are for the _rotation_ time, rather than
	 * the beginning of the period in the log file.
	 */
	if (indate) {
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
				out += manta_user;
				state = null;
				break;
			case 'U':
				out += customer;
				state = null;
				break;
			case 'r':
				out += logset.zonerole;
				state = null;
				break;
			case 'd':
				out += datacenter;
				state = null;
				break;
			case 'z':
				out += logset.zonename;
				state = null;
				break;
			case 'n':
				out += logset.zonename === 'global' ?
				    nodename : logset.zonename;
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
lookup_logset(setname)
{
	for (var i = 0; i < LOGSETS.length; i++) {
		if (LOGSETS[i].name === setname) {
			return (LOGSETS[i]);
		}
	}

	return (null);
}

function
ready()
{
	return (!!LOGSETS);
}

function
list_logsets()
{
	var out = [];

	if (!LOGSETS)
		return (out);

	for (var i = 0; i < LOGSETS.length; i++) {
		out.push(LOGSETS[i].name);
	}

	return (out);
}

/*
 * API:
 */
module.exports = {
	use_logsets: use_logsets,
	lookup_logset: lookup_logset,
	list_logsets: list_logsets,
	local_to_manta_path: local_to_manta_path,
	parse_date: parse_date,
	ready: ready,
	uuid_to_account: uuid_to_account
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
