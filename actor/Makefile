#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

#
# Use a build of node compiled to work in the global zone.  Since that is where
# actor will run.
#
NODE_PREBUILT_VERSION = v6.15.1
NODE_PREBUILT_TAG = gz
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_IMAGE =   18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

# Included definitions
include ../tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
    include ../tools/mk/Makefile.node_prebuilt.defs
else
    NPM=npm
    NODE=node
    NPM_EXEC=$(shell which npm)
    NODE_EXEC=$(shell which node)
endif

DESTDIR = $(PWD)

#
# Files shared by the server process and the actor:
#
COMMON_JS_FILES = \
	../lib/utils.js

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

.PHONY: all
all: $(NODE_EXEC) 0-npm-stamp

.PHONY: check
check:: 0-npm-stamp
	$(NODE_EXEC) node_modules/.bin/jshint $(ACTOR_JS_FILES)

$(DESTDIR)/actor.tar.gz: $(NODE_EXEC) 0-npm-stamp \
    $(ACTOR_JS_FILES) \
    $(COMMON_JS_FILES)
	/usr/bin/tar cfz $@ \
	    node_modules \
	    -C build/node bin/node \
	    -C build/node lib/libgcc_s.so.1 \
	    -C build/node lib/libstdc++.so.6 \
	    $(ACTOR_JS_FILES) \
	    $(COMMON_JS_FILES)

0-npm-stamp: $(NODE_EXEC) package.json
	rm -rf $(PWD)/node_modules
	PATH=$(PWD)/build/node/bin:$(PATH) NPM_CONFIG_CACHE= $(NPM_EXEC) install
	touch $@

clean::
	rm -f $(DESTDIR)/actor.tar.gz

include ../tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ../tools/mk/Makefile.node_prebuilt.targ
endif
include ../tools/mk/Makefile.targ

