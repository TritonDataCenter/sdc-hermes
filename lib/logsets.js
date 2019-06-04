/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var mod_fs = require('fs');
var mod_path = require('path');
var mod_assert = require('assert-plus');

var DEFAULT_DEBOUNCE_TIME = 600;
var DEFAULT_RETAIN_TIME = 0;

var LOGSETS;

function
load_logsets()
{
	var NAMES_SEEN = [];
	LOGSETS = JSON.parse(mod_fs.readFileSync(mod_path.join(__dirname,
	    '..', 'etc', 'logsets.json'), 'utf8'));
	for (var i = 0; i < LOGSETS.length; i++) {
		var ls = LOGSETS[i];

		ls.regex = new RegExp(ls.regex);
		mod_assert.optionalString(
		    ls.search_dirs_pattern,
		    'search_dirs_pattern');
		mod_assert.arrayOfString(ls.search_dirs, 'search_dirs');
		mod_assert.optionalBool(ls.no_upload, 'no_upload');
		mod_assert.string(ls.manta_path, 'manta_path');

		mod_assert.optionalNumber(ls.debounce_time, 'debounce_time');
		if (!ls.debounce_time)
			ls.debounce_time = DEFAULT_DEBOUNCE_TIME;

		mod_assert.optionalNumber(ls.retain_time, 'retain_time');
		if (!ls.retain_time)
			ls.retain_time = DEFAULT_RETAIN_TIME;

		mod_assert.ok(NAMES_SEEN.indexOf(ls.name) === -1,
				'duplicate logset name');
		NAMES_SEEN.push(ls.name);
	}
}

var COPY_FIELDS = [
	'search_dirs',
	'search_dirs_pattern',
	'manta_path',
	'date_string',
	'date_adjustment',
	'debounce_time',
	'retain_time',
	'customer_uuid',
	'no_upload'
];

/*
 * Create a JSON-safe object for transport across the wire to the actor:
 */
function
format_logset(logset, zonename, zonerole)
{
	var o = {
		name: logset.name + (zonename ? '@' + zonename : ''),
		zonename: zonename || 'global',
		zonerole: zonerole || 'global',
		regex: logset.regex.source
	};

	for (var i = 0; i < COPY_FIELDS.length; i++) {
		var cf = COPY_FIELDS[i];

		o[cf] = logset[cf];
	}

	return (o);
}

function
logsets_for_server(zone_list_for_server)
{
	var out = [];

	for (var i = 0; i < LOGSETS.length; i++) {
		var ls = LOGSETS[i];

		/*
		 * This logset applies to the global zone:
		 */
		if (ls.zones.indexOf('global') !== -1) {
			out.push(format_logset(ls));
		}

		for (var j = 0; j < zone_list_for_server.length; j++) {
			var zz = zone_list_for_server[j];
			if (ls.zones.indexOf(zz.role) !== -1) {
				out.push(format_logset(ls, zz.uuid, zz.role));
			}
		}
	}

	return (out);
}

/*
 * Initialisation:
 */
load_logsets();

/*
 * API:
 */
module.exports = {
	logsets_for_server: logsets_for_server
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
