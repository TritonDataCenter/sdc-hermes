#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

TOP =			$(PWD)

#
# Use a build of node compiled on the oldest supported SDC 6.5 platform:
#
MANTA_BASE =		http://us-east.manta.joyent.com
NODE_VERSION =		v0.10.26
NODE_TARBALL =		node-$(NODE_VERSION)-sdc65.tar.gz
NODE_BASE_URL =		$(MANTA_BASE)/Joyent_Dev/public/old_node_builds

NODE_EXEC =		$(PWD)/node/bin/node
NPM_EXEC =		$(NODE_EXEC) $(PWD)/node/bin/npm

DESTDIR =		$(PWD)/proto

#
# Files that run in the sdc zone:
#
JS_FILES = \
	hermes.js \
	proxy.js \
	lib/httpserver.js \
	lib/logsets.js \
	lib/proxy_server.js \
	lib/scripts.js \
	lib/servers.js \
	lib/zones.js

#
# Files shared by the server process and the actor:
#
COMMON_JS_FILES = \
	lib/utils.js

#
# Files shipped to the compute node by the actor deployment mechanism:
#
ACTOR_JS_FILES = \
	actor.js \
	lib/cmd.js \
	lib/conn.js \
	lib/findstream.js \
	lib/logsets.js \
	lib/remember.js \
	lib/worker.js

#
# Script files run via CNAPI ServerExecute to deploy the actor to compute
# nodes:
#
SCRIPTS = \
	actor.ksh \
	actor.xml \
	bootstrap.ksh

SAPI_MANIFESTS = \
	hermes \
	hermes-proxy
SAPI_FILES = \
	$(addsuffix /template,$(SAPI_MANIFESTS)) \
	$(addsuffix /manifest.json,$(SAPI_MANIFESTS))

PREFIX = /opt/smartdc/hermes
INSTALL_DIRS = \
	$(DESTDIR)$(PREFIX)/bin \
	$(DESTDIR)$(PREFIX)/lib \
	$(DESTDIR)$(PREFIX)/etc \
	$(DESTDIR)$(PREFIX)/scripts \
	$(DESTDIR)$(PREFIX)/smf

INSTALL_FILES = \
	$(addprefix $(DESTDIR)$(PREFIX)/,$(JS_FILES)) \
	$(addprefix $(DESTDIR)$(PREFIX)/,$(COMMON_JS_FILES)) \
	$(addprefix $(DESTDIR)$(PREFIX)/scripts/,$(SCRIPTS)) \
	$(DESTDIR)$(PREFIX)/bin/node \
	$(DESTDIR)$(PREFIX)/smf/hermes.xml \
	$(DESTDIR)$(PREFIX)/smf/hermes-proxy.xml \
	$(addprefix $(DESTDIR)$(PREFIX)/sapi_manifests/,$(SAPI_FILES)) \
	$(DESTDIR)$(PREFIX)/actor.tar.gz

CHECK_JS_FILES = \
	$(JS_FILES) \
	$(COMMON_JS_FILES) \
	$(addprefix actor/,$(ACTOR_JS_FILES))

.PHONY: all
all: $(NODE_EXEC) 0-npm-stamp

.PHONY: check
check: 0-npm-stamp
	$(NODE_EXEC) node_modules/.bin/jshint $(CHECK_JS_FILES)

.PHONY: xxx
xxx:
	@GIT_PAGER= git grep "XXX" $(CHECK_JS_FILES)

.PHONY: install
install: $(INSTALL_DIRS) $(DESTDIR)$(PREFIX)/node_modules $(INSTALL_FILES)

$(DESTDIR)$(PREFIX)/actor.tar.gz: $(ACTOR_JS_FILES:%=actor/%) \
    $(COMMON_JS_FILES) $(DESTDIR)$(PREFIX)/bin/node \
    $(DESTDIR)$(PREFIX)/node_modules
	/usr/bin/tar cfz $@ \
	    -C $(DESTDIR)$(PREFIX) node_modules \
	    -C $(DESTDIR)$(PREFIX) bin/node \
	    $(ACTOR_JS_FILES:%=-C $(TOP)/actor %) \
	    $(COMMON_JS_FILES:%=-C $(TOP) %)

$(INSTALL_DIRS):
	mkdir -p $@

$(DESTDIR)$(PREFIX)/scripts/%: $(PWD)/scripts/%
	cp $^ $@

$(DESTDIR)$(PREFIX)/lib/%.js: $(PWD)/lib/%.js
	cp $^ $@

$(DESTDIR)$(PREFIX)/%.js: $(PWD)/%.js
	cp $^ $@

$(DESTDIR)$(PREFIX)/bin/node: $(PWD)/node/bin/node
	cp $^ $@

$(DESTDIR)$(PREFIX)/smf/%.xml: $(PWD)/smf/manifests/%.xml.in
	sed -e 's,@@NODE@@,@@PREFIX@@/bin/node,g' \
	    -e 's,@@PREFIX@@,$(PREFIX),g' \
	    < $^ > $@

$(DESTDIR)$(PREFIX)/sapi_manifests/%: $(PWD)/sapi_manifests/%
	@mkdir -p `dirname $@`
	cp $^ $@

0-npm-stamp: $(NODE_EXEC) package.json
	rm -rf $(PWD)/node_modules
	PATH=$(PWD)/node/bin:$(PATH) NPM_CONFIG_CACHE= $(NPM_EXEC) install
	touch $@

$(DESTDIR)$(PREFIX)/node_modules: 0-npm-stamp
	rm -rf $@
	cp -r $(PWD)/node_modules $@

downloads/$(NODE_TARBALL):
	@echo "downloading node $(NODE_VERSION) ..."
	mkdir -p `dirname $@`
	curl -fsS -kL -o $@ '$(NODE_BASE_URL)/$(NODE_TARBALL)'

$(NODE_EXEC): downloads/$(NODE_TARBALL)
	@echo "extracting node $(NODE_VERSION) ..."
	mkdir -p node
	gtar -xz -C node -f downloads/$(NODE_TARBALL)
	[[ -f $(NODE_EXEC) ]] && touch $(NODE_EXEC)

clean:
	rm -rf $(PWD)/node_modules
	rm -rf $(PWD)/proto

clobber: clean
	rm -rf $(PWD)/downloads
	rm -rf $(PWD)/node

