/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Returns all files matching a found matching a glob string.
 */

var mod_child = require('child_process');
var mod_verror = require('verror');
var mod_assert = require('assert-plus');

function list_glob(pattern, callback) {
	mod_assert.string(pattern, 'pattern');
	mod_assert.func(callback, 'callback');

	/*
	 * We want to allow filename expansion to happen, however, we do not want
	 * to break if given paths with spaces. Here we lean on the shell IFS
	 * variable to prevent the shell from splitting the path on spaces.
	 */
	var args = [
		'-c',
		'IFS=""; ls -1Ud $0',
		pattern
	];

	var opts = {
		env: {},
		cwd: '/',
		maxBuffer: 1024 * 1024
	};

	mod_child.execFile('/bin/bash', args, opts, onExec);

	function onExec(err, stdout, stderr) {
		if (err) {
			callback(
			    new mod_verror.VError(err,
			    'could not list files matching pattern'));
			return;
		}
		callback(null, stdout.toString().trim().split('\n'));
	}
}


module.exports = {
	list_glob: list_glob
};

/* vim: set ts=8 sts=8 sw=8 noet: */
