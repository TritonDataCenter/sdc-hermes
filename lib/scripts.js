/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');

var mod_verror = require('verror');

function
ScriptManager(root)
{
	var self = this;

	self.sm_root = root;
	self.sm_scripts = [];
}

ScriptManager.prototype._lookup = function
_lookup(name)
{
	var self = this;

	for (var i = 0; i < self.sm_scripts.length; i++) {
		var script = self.sm_scripts[i];

		if (script.scr_name === name)
			return (script);
	}

	return (null);
};

ScriptManager.prototype.load = function
load(name, dict)
{
	var self = this;
	var script = self._lookup(name);

	dict = dict || {};

	if (!script) {
		var path = mod_path.join(self.sm_root, name);
		var body;
		try {
			body = mod_fs.readFileSync(path, 'utf8');
		} catch (ex) {
			throw (new mod_verror.VError(ex,
			    'could not load script "%s"', name));
		}
		script = {
			scr_name: name,
			scr_body: body
		};
		self.sm_scripts.push(script);
	}

	var out = script.scr_body;
	for (var key in dict) {
		if (!dict.hasOwnProperty(key))
			continue;

		var re = new RegExp('%%' + key + '%%', 'g');
		out = out.replace(re, dict[key]);
	}

	return (out);
};

module.exports = {
	ScriptManager: ScriptManager
};
