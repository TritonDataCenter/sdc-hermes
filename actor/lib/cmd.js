/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var mod_child = require('child_process');

var mod_verror = require('verror');

var VError = mod_verror.VError;

function
svccfg(args, _, next)
{
	if (typeof (_) === 'function')
		next = _;
	mod_child.execFile('/usr/sbin/svccfg', args, function (err, so, se) {
		if (err) {
			next(new VError(err, 'svccfg ' + args.join(' ') +
			    ': ' + se));
			return;
		}
		next();
	});
}

function
svcadm(args, _, next)
{
	if (typeof (_) === 'function')
		next = _;
	mod_child.execFile('/usr/sbin/svcadm', args, function (err, so, se) {
		if (err) {
			next(new VError(err, 'svcadm ' + args.join(' ') +
			    ': ' + se));
			return;
		}
		next();
	});
}

function
svcprop(args, _, next)
{
	if (typeof (_) === 'function')
		next = _;
	mod_child.execFile('/usr/bin/svcprop', args, function (err, so, se) {
		if (err) {
			next(new VError(err, 'svcprop ' + args.join(' ') +
			    ': ' + se));
			return;
		}
		next(null, so.trim());
	});
}

module.exports = {
	svccfg: svccfg,
	svcadm: svcadm,
	svcprop: svcprop
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
