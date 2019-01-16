#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

#
# Use a build of node compiled to work in the global zone.
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

.PHONY: all
all: $(NODE_EXEC)

include ../tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ../tools/mk/Makefile.node_prebuilt.targ
endif
include ../tools/mk/Makefile.targ
