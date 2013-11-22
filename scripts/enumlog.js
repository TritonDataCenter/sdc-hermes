#!/usr/node/bin/node
/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');

var LOGSETS = %%LOGSETS%%;
var RESULTS = [];

console.error('LOGSETS: %j', LOGSETS);

function
walk_dir(zonename, zonerole, ls, dir)
{
	var ents;
	var now = Math.floor((+Date.now()) / 1000);

	var statdir = dir;
	if (zonename !== 'global') {
		statdir = mod_path.join('/zones', zonename, 'root',
		    dir);
		console.error('DIR %s\nSTAT DIR %s\n', dir, statdir);
	}

	try {
		ents = mod_fs.readdirSync(statdir);
		console.error('*** FOUND DIR  %s  ***\n', statdir);
	} catch (err) {
		return;
	}
	for (var i = 0; i < ents.length; i++) {
		var ent = ents[i];
		var path = mod_path.join(dir, ent);
		var statpath = mod_path.join(statdir, ent);

		console.error('PATH %s\nSTAT PATH %s\n', path, statpath);

		var st = mod_fs.lstatSync(statpath);
		var age = now - Math.floor((+st.mtime) / 1000);

		if (st.isFile() && (age > ls.debounce_time) &&
		    ls.regex.test(path)) {
			RESULTS.push({
				logset: ls.name,
				path: path,
				mtime: st.mtime,
				zonename: zonename,
				zonerole: zonerole
			});
		} else if (st.isDirectory()) {
			walk_dir(zonename, zonerole, ls, path);
		}
	}
}

function
sort_by_mtime(a, b)
{
	/*
	 * We sort by modified time so that the oldest log files
	 * on the system are discovered first in the case where we
	 * have more than the cap count.  To ensure a stable total
	 * ordering in the case of identical mtimes, we also sort on
	 * the path as a fallback.
	 */
	return (a.mtime > b.mtime ? 1 : a.mtime < b.mtime ? -1 :
	    a.path > b.path ? 1 : a.path < b.path ? -1 : 0);
}

(function
main()
{
	try {
		for (var i = 0; i < LOGSETS.length; i++) {
			/*
			 * Reconstitute regular expressions:
			 */
			LOGSETS[i].regex = new RegExp(LOGSETS[i].regex);
		}
	} catch (err) {
		console.error('ERROR: could not parse logsets (stdin)');
		console.error('%s', err.stack);
		process.exit(1);
	}

	for (var i = 0; i < LOGSETS.length; i++) {
		var logset = LOGSETS[i];
		var zonename = LOGSETS[i].zonename;
		var zonerole = LOGSETS[i].zonerole;

		for (var j = 0; j < logset.search_dirs.length; j++) {
			var search_dir = logset.search_dirs[j];
			if (zonename !== 'global') {
				search_dir = mod_path.join('/zones', zonename,
				    'root', search_dir);
			}
			walk_dir(zonename, zonerole, logset,
			    logset.search_dirs[j]);
		}
	}

	/*
	 * Get a consistent, stable ordering on log files in the system
	 * and then ensure we only emit the first 100 records.  This prevents
	 * overunning the buffer that ur is prepared to send back to hermes.
	 * As the oldest log files are uploaded they will be removed, and
	 * our window will slide forwards to the newer logs.
	 */
	RESULTS.sort(sort_by_mtime);
	RESULTS = RESULTS.slice(0, 100);

	console.log('%j', RESULTS);
	process.exit(0);
})();
