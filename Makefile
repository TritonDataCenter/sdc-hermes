#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

TOP =			$(PWD)

#
# Use a build of node compiled to work in the global zone.
#
NODE_PREBUILT_VERSION = v6.15.1
NODE_PREBUILT_TAG = gz
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_IMAGE =   18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

# Included definitions
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
    include ./tools/mk/Makefile.node_prebuilt.defs
else
    NPM=npm
    NODE=node
    NPM_EXEC=$(shell which npm)
    NODE_EXEC=$(shell which node)
endif

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
	$(DESTDIR)$(PREFIX)/lib/libgcc_s.so.1 \
	$(DESTDIR)$(PREFIX)/lib/libstdc++.so.6 \
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
check:: 0-npm-stamp
	$(NODE_EXEC) node_modules/.bin/jshint $(CHECK_JS_FILES)

.PHONY: xxx
xxx:
	@GIT_PAGER= git grep "XXX" $(CHECK_JS_FILES)

.PHONY: install
install: $(INSTALL_DIRS) $(DESTDIR)$(PREFIX)/node_modules $(INSTALL_FILES)

$(DESTDIR)$(PREFIX)/actor.tar.gz: $(ACTOR_JS_FILES:%=actor/%) \
    $(COMMON_JS_FILES) $(DESTDIR)$(PREFIX)/bin/node \
    $(DESTDIR)$(PREFIX)/lib/libgcc_s.so.1 \
    $(DESTDIR)$(PREFIX)/lib/libstdc++.so.6 \
    $(DESTDIR)$(PREFIX)/node_modules
	/usr/bin/tar cfz $@ \
	    -C $(DESTDIR)$(PREFIX) node_modules \
	    -C $(DESTDIR)$(PREFIX) bin/node \
	    -C $(DESTDIR)$(PREFIX) lib/libgcc_s.so.1 \
	    -C $(DESTDIR)$(PREFIX) lib/libstdc++.so.6 \
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

$(DESTDIR)$(PREFIX)/bin/node: $(PWD)/build/node/bin/node
	cp $^ $@

$(DESTDIR)$(PREFIX)/lib/lib%: $(PWD)/build/node/lib/lib%
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

#$(NODE_TARBALL):
	#@echo "downloading sdcnode $(NODE_VARIANT) ..."
	#mkdir -p $(@D)
	#./tools/download_sdcnode $(NODE_IMAGE) $(NODE_VARIANT) $(@D)

#$(NODE_EXEC): $(NODE_TARBALL)
	#@echo "extracting node $(NODE_VERSION) ..."
	#-rm -rf node
	#gtar -xz -f $(NODE_TARBALL)
	#[[ -f $(NODE_EXEC) ]] && touch $(NODE_EXEC)

clean::
	rm -rf $(PWD)/node_modules
	rm -rf $(PWD)/proto

clobber: clean
	rm -rf $(PWD)/downloads
	rm -rf $(PWD)/node

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.targ
