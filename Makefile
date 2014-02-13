

# Using a smartos/1.6.3-based sdcnode build for now.
SDCNODE_BASE = \
	https://download.joyent.com/pub/build/sdcnode/01b2c898-945f-11e1-a523-af1afbe22822/master-20140131T234453Z/sdcnode/
SDCNODE_TARBALL = \
	sdcnode-v0.10.18-zone-01b2c898-945f-11e1-a523-af1afbe22822-master-20140131T214003Z-gf904429.tgz

NODE_EXEC = $(PWD)/node/bin/node
NPM_EXEC = $(NODE_EXEC) $(PWD)/node/bin/npm

DESTDIR = $(PWD)/proto

JS_FILES = \
	hermes.js \
	lib/httpserver.js \
	lib/inflight.js \
	lib/logsets.js \
	lib/mq.js \
	lib/mq_child.js \
	lib/utils.js \
	lib/zones.js

SCRIPTS = \
	enumlog.js \
	pushlog.ksh \
	removelog.ksh

SAPI_MANIFESTS = hermes
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
	$(addprefix $(DESTDIR)$(PREFIX)/scripts/,$(SCRIPTS)) \
	$(DESTDIR)$(PREFIX)/bin/node \
	$(DESTDIR)$(PREFIX)/smf/hermes.xml \
	$(addprefix $(DESTDIR)$(PREFIX)/sapi_manifests/,$(SAPI_FILES))

.PHONY: all
all: $(NODE_EXEC) 0-npm-stamp

.PHONY: check
check:
	jshint $(JS_FILES)

.PHONY: install
install: $(INSTALL_DIRS) $(DESTDIR)$(PREFIX)/node_modules $(INSTALL_FILES)

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
	PATH=$(PWD)/node/bin:$(PATH) $(NPM_EXEC) install
	touch $@

$(DESTDIR)$(PREFIX)/node_modules: 0-npm-stamp
	rm -rf $@
	cp -r $(PWD)/node_modules $@

downloads/$(SDCNODE_TARBALL):
	mkdir $(PWD)/downloads
	cd $(PWD)/downloads && \
	curl -fsS -kOL $(SDCNODE_BASE)$(SDCNODE_TARBALL)
	touch $@

$(NODE_EXEC): downloads/$(SDCNODE_TARBALL)
	tar xfz downloads/$(SDCNODE_TARBALL)
	[[ -f $(NODE_EXEC) ]] && touch $(NODE_EXEC)

clean:
	rm -rf $(PWD)/proto

clobber: clean
	rm -rf $(PWD)/downloads
	rm -rf $(PWD)/node

