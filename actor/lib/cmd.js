/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_forkexec = require('forkexec');
var mod_verror = require('verror');

var VE = mod_verror.VError;

function
svccfg(args, next)
{
	mod_assert.arrayOfString(args, 'args');
	mod_assert.func(next, 'next');

	mod_forkexec.forkExecWait({
		argv: [ '/usr/sbin/svccfg' ].concat(args),
		includeStderr: true
	}, function (err, info) {
		next(err);
	});
}

function
svcadm(args, next)
{
	mod_assert.arrayOfString(args, 'args');
	mod_assert.func(next, 'next');

	mod_forkexec.forkExecWait({
		argv: [ '/usr/sbin/svcadm' ].concat(args),
		includeStderr: true
	}, function (err, info) {
		next(err);
	});
}

function
svcprop(args, next)
{
	mod_assert.arrayOfString(args, 'args');
	mod_assert.func(next, 'next');

	mod_forkexec.forkExecWait({
		argv: [ '/usr/bin/svcprop' ].concat(args),
		includeStderr: true
	}, function (err, info) {
		if (err) {
			next(err);
			return;
		}
		next(null, info.stdout.trim());
	});
}

function
sysinfo(next)
{
	mod_assert.func(next, 'next');

	mod_forkexec.forkExecWait({
		argv: [ '/usr/bin/sysinfo' ],
		includeStderr: true
	}, function (err, info) {
		if (err) {
			next(err);
			return;
		}

		var o;
		try {
			o = JSON.parse(info.stdout);
		} catch (ex) {
			next(new VE(ex, 'invalid sysinfo JSON'));
			return;
		}

		next(null, o);
	});
}

module.exports = {
	svccfg: svccfg,
	svcadm: svcadm,
	svcprop: svcprop,
	sysinfo: sysinfo
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
