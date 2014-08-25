/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var mod_util = require('util');
var mod_stream = require('stream');
var mod_fs = require('fs');
var mod_child = require('child_process');
var mod_lstream = require('lstream');

var mod_verror = require('verror');

var FIND = '/usr/bin/find';

function
StatStream()
{
	mod_stream.Transform.call(this, {
		objectMode: true
	});
}
mod_util.inherits(StatStream, mod_stream.Transform);

StatStream.prototype._transform = function
_transform(chunk, _, done)
{
	var self = this;

	mod_fs.lstat(chunk, function (err, stat) {
		if (err) {
			if (err.code === 'ENOENT') {
				/*
				 * We probably raced with a file
				 * removal.
				 */
				done();
			} else {
				done(err);
			}
			return;
		}

		if (stat.isFile()) {
			self.push({
				path: chunk,
				mtime: stat.mtime,
				size: stat.size
			});
		}

		done();
	});
};

function
FindStream(dirs)
{
	var self = this;
	mod_stream.PassThrough.call(self, {
		objectMode: true
	});

	self.ds_lstream = new mod_lstream();
	self.ds_statstream = new StatStream();

	self.ds_stderr = '';
	self.ds_destroyed = true;

	var args = dirs.concat([
		'-type', 'f',
		'-print'
	]);
	var opts = {
		env: {},
		cwd: '/'
	};

	self.ds_proc = mod_child.spawn(FIND, args, opts);

	/*
	 * Listen for process conditions:
	 */
	self.ds_proc.once('error', function (err) {
		if (self.ds_destroyed)
			return;
		self.ds_proc = null;
		self.emit('error', err);
	});
	self.ds_proc.once('close', function (code, signal) {
		if (self.ds_destroyed)
			return;
		self.ds_proc = null;
		if (code !== 0 || signal) {
			var err = new mod_verror.VError('find error; ' +
			    'code %d signal %s; stderr: %s', code, signal,
			    self.ds_stderr);
			self.emit('error', err);
			return;
		}
	});

	/*
	 * Save stderr, close stdin:
	 */
	self.ds_proc.stderr.on('data', function (chunk) {
		self.ds_stderr += chunk.toString();
	});
	self.ds_proc.stdin.end();

	/*
	 * stdout is a stream of \n-separated paths; pipe it
	 * into the StatStream, and pipe that into ourselves
	 * for consumers.
	 */
	self.ds_proc.stdout.pipe(self.ds_lstream).pipe(self.ds_statstream).
	    pipe(self);
}
mod_util.inherits(FindStream, mod_stream.PassThrough);

FindStream.prototype.destroy = function
destroy()
{
	var self = this;

	if (self.ds_destroyed)
		return;
	self.ds_destroyed = true;

	/*
	 * Break the pipeline:
	 */
	if (self.ds_statstream) {
		self.ds_statstream.unpipe(self);
		self.ds_statstream = null;
	}

	if (self.ds_proc) {
		try {
			self.ds_proc.kill('SIGKILL');
		} catch (ex) {
			/*
			 * XXX Ignore errors, here, for now.
			 */
			console.error('ERROR: failed to kill find: ' +
			    ex.stack);
		}
		self.ds_proc = null;
	}

	/*
	 * Signal the end of our outbound stream:
	 */
	self.push(null);
};

module.exports = {
	FindStream: FindStream
};

/* vim: set ts=8 sts=8 sw=8 noet: */
