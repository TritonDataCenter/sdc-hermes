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
var mod_crypto = require('crypto');

var mod_assert = require('assert-plus');
var mod_vasync = require('vasync');
var mod_once = require('once');
var mod_verror = require('verror');

var lib_logsets = require('./logsets');
var lib_findstream = require('./findstream');
var lib_remember = require('./remember');

var VError = mod_verror.VError;

/*
 * Global memoisation cache for uploads.
 */
var REMEMBER = new lib_remember.Remember();

function
LogsetWorker(options)
{
	var self = this;

	mod_assert.string(options.manta_user, 'options.manta_user');
	mod_assert.object(options.manta, 'options.manta');
	mod_assert.object(options.logset, 'options.logset');
	mod_assert.object(options.log, 'options.log');
	mod_assert.string(options.datacenter, 'options.datacenter');
	mod_assert.string(options.nodename, 'options.nodename');

	self.lsw_log = options.log;
	self.lsw_manta = options.manta;
	self.lsw_mahi = options.mahi;

	self.lsw_logset = options.logset;

	self.lsw_manta_user = options.manta_user;
	self.lsw_datacenter = options.datacenter;
	self.lsw_nodename = self.lsw_logset.zonename === 'global' ?
	    options.nodename : self.lsw_logset.zonename;

	self.lsw_path_prefix = self.lsw_logset.zonename === 'global' ?
	    '' : mod_path.join('/zones', self.lsw_logset.zonename, 'root');

	self.lsw_dispatched = false;
	self.lsw_ended = false;
	self.lsw_started = false;
	self.lsw_find_ended = false;
	self.lsw_cancel = false;

	self.lsw_end_callback = null;
	self.lsw_end_error = null;

	self.lsw_barrier = mod_vasync.barrier();
	self.lsw_barrier.start('init phase');

	self.lsw_manta_pipeline = null;
	self.lsw_manta_task = null;

	/*
	 * This barrier synchronises the end of the various tasks and
	 * queues that make up a logset enumeration and processing run.
	 */
	self.lsw_barrier.on('drain', function () {
		mod_assert.ok(!self.lsw_dispatched, '!lsw_dispatched');
		mod_assert.ok(!self.lsw_ended, '!lsw_ended');
		mod_assert.ok(self.lsw_started, 'lsw_started');

		self.lsw_ended = true;

		self.lsw_end_callback(self.lsw_end_error);
	});
}

LogsetWorker.prototype.destroy = function
destroy()
{
	var self = this;

	if (self.lsw_cancel)
		return;
	self.lsw_cancel = true;

	if (self.lsw_findstream)
		self.lsw_findstream.destroy();
};

LogsetWorker.prototype.run = function
run(callback)
{
	var self = this;

	mod_assert.ok(!self.lsw_started, 'cannot run() a worker twice');
	self.lsw_started = true;

	/*
	 * Store the end callback for later.
	 */
	mod_assert.func(callback, 'callback');
	self.lsw_end_callback = callback;

	/*
	 * Add zoneroot prefix to search directories if we're looking
	 * at the non-global zone.
	 */
	var adjdirs = [];
	for (var i = 0; i < self.lsw_logset.search_dirs.length; i++) {
		adjdirs.push(mod_path.join(self.lsw_path_prefix,
		    self.lsw_logset.search_dirs[i]));
	}

	self.lsw_barrier.start('find');
	var find = new lib_findstream.FindStream(adjdirs);

	find.on('error', function (err) {
		/*
		 * XXX It's possible that there's a class of error we can
		 * or should do something about, here.  For now, just
		 * log it and roll on.
		 *
		 * In fact, short of an entirely egregious error that prevents
		 * _any_ files from being uploaded -- this will hopefully
		 * result in a core, anyway -- we'd like to roll on and get
		 * as much work done as possible.
		 */
		self.lsw_log.error({
			err: err
		}, 'find stream error');
	});

	find.on('readable', function () {
		self._disp();
	});

	find.on('end', function () {
		self.lsw_find_ended = true;
		self.lsw_barrier.done('find');
	});

	self.lsw_findstream = find;

	self.lsw_barrier.done('init phase');
};

LogsetWorker.prototype._disp = function
_disp()
{
	var self = this;

	if (self.lsw_dispatched)
		return;

	self.lsw_log.trace('_disp(): not dispatched; running');

	var inf = self.lsw_findstream.read();
	if (!inf)
		return;

	self.lsw_log.trace({
		file: inf
	}, '_disp(): read from find stream');

	/*
	 * We have a find stream object to process.  Mark us as dispatched.
	 */
	self.lsw_dispatched = true;

	var bname = 'dispatch ' + inf.path;
	self.lsw_barrier.start(bname);

	var _swtch = function _swtch() {
		self.lsw_barrier.done(bname);
		self.lsw_dispatched = false;
		setImmediate(function () {
			self._disp();
		});
	};

	/*
	 * Adjust for potential zoneroot prefix:
	 */
	inf.real_path = inf.path;
	mod_assert.strictEqual(inf.path.substr(0, self.lsw_path_prefix.length),
	    self.lsw_path_prefix);
	inf.path = inf.path.substr(self.lsw_path_prefix.length);

	/*
	 * Check that this file matches the logset definition.
	 */
	if (!self.lsw_logset.regex.test(inf.path)) {
		self.lsw_log.debug({
			file: inf
		}, 'file does not match regex');
		_swtch();
		return;
	}

	/*
	 * We must debounce on the both the file mtime and, if relevant,
	 * the date/time we parse out of the filename.
	 */
	mod_assert.number(self.lsw_logset.debounce_time);

	var file_mtime = inf.mtime.valueOf();

	var filename_date = lib_logsets.parse_date(self.lsw_logset,
	    inf.path);
	var file_parsed_time = filename_date === null ? 0 :
	    filename_date.valueOf();

	/*
	 * The later of these, plus the debounce_time, represents the moment in
	 * time after which it is believed the file will no longer change and
	 * can thus be archived into Manta.
	 */
	var archive_after = Math.max(file_parsed_time, file_mtime) +
	    (self.lsw_logset.debounce_time * 1000);

	/*
	 * If the archival moment has not been crossed, then skip this file
	 * for now.  We will pick it up again on a later enumeration.
	 */
	var now = Date.now();
	if (now < archive_after) {
		self.lsw_log.debug({
			file: inf,
			file_parsed_time: filename_date,
		}, 'file not old enough; skipping');
		_swtch();
		return;
	}

	/*
	 * After we have archived the file, we must wait for the retention_time
	 * before deleting it.  This allows us the confluence of timely
	 * archival into Manta and some number of files left on the originating
	 * host for local operator consumption.
	 */
	var delete_after = archive_after + (self.lsw_logset.retain_time * 1000);
	var _delete = (now >= delete_after);

	/*
	 * Derive the path that we would upload this file to, in Manta:
	 */
	lib_logsets.uuid_to_account(self.lsw_logset, inf.path, self.lsw_mahi,
	function getAccount(err, customer) {
		if (err) {
		    self.lsw_log.error({
			err: err
		    }, 'failed to translate customer UUID to Manta account');
		    _swtch();
		    return;
		}

		var manta_path = lib_logsets.local_to_manta_path(self.lsw_manta_user,
		    self.lsw_logset, inf.path, self.lsw_datacenter, self.lsw_nodename,
		    customer);

		/*
		 * If we are not attempting to delete the file, an act that may cause
		 * permanent data loss if mishandled, we can trust our memory of a
		 * recent verification.
		 */
		if (!_delete && REMEMBER.uploaded_already(inf.real_path, manta_path,
		    inf.mtime.valueOf())) {
			self.lsw_log.trace({
				file: inf
			}, 'upload remembered; skipping until deletion required');
			_swtch();
			return;
		}

		self.lsw_log.debug({
			file: inf,
			manta_path: manta_path,
			do_delete: _delete
		}, 'archiving log file');

		self._manta_upload(inf, manta_path, _delete, function (err) {
			if (err) {
				self.lsw_log.error({
					err: err
				}, 'failed to upload file to Manta');
				setTimeout(function () {
					/*
					 * Inject a pause, and then continue...
					 */
					_swtch();
				}, 1000);
				return;
			}

			/*
			 * We have either uploaded this file, or verified that it has
			 * previously been uploaded with identical contents.  Cache
			 * this to avoid needing to re-verify in the next enumeration:
			 */
			REMEMBER.mark_uploaded(inf.real_path, manta_path,
			    inf.mtime.valueOf());
			_swtch();
			return;
		});
	});
};

function
pl_local_md5(t, next)
{
	if (t.t_cancel) {
		next();
		return;
	}

	var hash = mod_crypto.createHash('md5');

	mod_assert.string(t.t_file.real_path, 'file.real_path');
	var fin = mod_fs.createReadStream(t.t_file.real_path);

	next = mod_once(next);

	fin.on('readable', function () {
		var buf;
		while (!!(buf = fin.read())) {
			hash.update(buf);
		}
	});
	fin.on('end', function () {
		t.t_md5_local = hash.digest('base64');
		next();
	});
	fin.on('error', next);
}

function
pl_manta_info(t, next)
{
	if (t.t_cancel) {
		next();
		return;
	}

	t.t_manta.info(t.t_manta_path, function (err, info) {
		if (err) {
			next(new VError(err, 'could not get info for ' +
			    'manta path: %s', t.t_manta_path));
			return;
		}

		t.t_log.trace({
			md5: info.md5
		}, 'manta file exists');
		t.t_md5_remote = info.md5;
		next();
	});
}

function
pl_manta_mkdirp(t, next)
{
	if (t.t_cancel) {
		next();
		return;
	}

	var dirname = mod_path.dirname(t.t_manta_path);
	t.t_manta.mkdirp(dirname, function (err) {
		if (err) {
			next(new VError(err, 'could not mkdirp: %s',
			    dirname));
			return;
		}

		t.t_log.trace({
			manta_dir: dirname
		}, 'mkdirp succeeded');

		next();
	});
}

function
pl_manta_put(t, next)
{
	if (t.t_cancel) {
		next();
		return;
	}

	next = mod_once(next);

	mod_assert.string(t.t_md5_local, 'md5_local');
	mod_assert.number(t.t_file.size, 'file.size');

	var opts = {
		md5: t.t_md5_local,
		size: t.t_file.size,
		headers: {
			/*
			 * HTTP Precondition prevents replacement of a file
			 * if we're racing with another uploader:
			 */
			'if-match': '""'
		}
	};

	var finstr = mod_fs.createReadStream(t.t_file.real_path);
	finstr.on('error', function (err) {
		next(new VError(err, 'file read error: %s',
		    t.t_file.real_path));
		return;
	});

	var start = Date.now();
	t.t_manta.put(t.t_manta_path, finstr, opts, function (err) {
		/*
		 * As we have literally no idea what the Manta client has done
		 * with the stream we passed it, we will immediately
		 * defensively destroy the file stream.  If there is still a
		 * file descriptor associated with it, for whatever reason,
		 * this should ensure that we don't leak it.
		 *
		 * With file descriptors, it is best to take the "Glengarry
		 * Glen Ross" approach: Always Be Closing.
		 */
		finstr.destroy();

		if (err && err.name !== 'PreconditionFailedError') {
			next(new VError(err, 'manta put error: %s',
			    t.t_manta_path));
			return;
		}

		if (err) {
			t.t_log.trace({
				err: err
			}, 'manta file existed already while putting');
			next();
			return;
		}

		t.t_log.info({
			upload_time_ms: Date.now() - start,
			md5: t.t_md5_local
		}, 'uploaded log file to manta');
		next();
		return;
	});
}

function
pl_compare_hash(t, next)
{
	if (t.t_cancel) {
		next();
		return;
	}

	mod_assert.string(t.t_md5_local, 'md5_local');

	var err;
	if (t.t_md5_local !== t.t_md5_remote) {
		err = new VError('the local file "%s" does not match ' +
		    ' the file in Manta "%s"', t.t_file.real_path,
		    t.t_manta_path);
		err.md5_remote = t.t_md5_remote;
		err.md5_local = t.t_md5_local;
		err.local_path = t.t_file.real_path;
	}

	next(err);
	return;
}

function
pl_local_rm(t, next)
{
	if (t.t_cancel || !t.t_do_delete) {
		next();
		return;
	}

	mod_assert.string(t.t_md5_remote);
	mod_assert.string(t.t_md5_local);
	mod_assert.strictEqual(t.t_md5_remote, t.t_md5_local);
	mod_assert.strictEqual(t.t_do_delete, true);

	mod_fs.unlink(t.t_file.real_path, function (err) {
		if (err && err.code !== 'ENOENT') {
			next(new VError(err, 'could not remove file: %s',
			    t.t_file.real_path));
			return;
		}

		if (err) {
			t.t_log.warn({
				err: err
			}, 'attempted to unlink file that did not exist');
		} else {
			t.t_log.info('removed local file');
		}

		next();
		return;
	});
}

LogsetWorker.prototype._manta_upload = function
_manta_upload(file, manta_path, _delete, next)
{
	var self = this;

	mod_assert.ok(!self.lsw_manta_task, '!lsw_manta_task');
	self.lsw_manta_task = {
		t_log: self.lsw_log.child({
			file: file,
			manta_path: manta_path,
			do_delete: _delete
		}),
		t_manta: self.lsw_manta,
		t_manta_path: manta_path,
		t_file: file,
		t_do_delete: _delete,
		t_md5_remote: null,
		t_md5_local: null,
		t_cancel: self.lsw_cancel
	};

	var start = Date.now();
	self.lsw_manta_pipeline = mod_vasync.pipeline({
		arg: self.lsw_manta_task,
		funcs: [
			/*
			 * Generate md5 hash of file and attempt to upload:
			 */
			pl_local_md5,
			pl_manta_mkdirp,
			pl_manta_put,
			/*
			 * Check the current state of the file in Manta and
			 * ensure it matches the md5 hash of the local file:
			 */
			pl_manta_info,
			pl_compare_hash,
			/*
			 * Unlink the local file if the retention period has
			 * passed:
			 */
			pl_local_rm
		]
	}, function (err) {
		self.lsw_manta_task.t_log.debug({
			runtime_ms: Date.now() - start,
			err: err
		}, '_manta_upload pipeline ends');
		self.lsw_manta_task = null;
		next(err);
	});
};

module.exports = {
	LogsetWorker: LogsetWorker
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
