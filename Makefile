# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# You may override the following vars on the command line to suit
# your config.
CXX=clang++
CXXFLAGS=-O2 -Wall
BUILD=0
PARALLEL=$(shell nproc)

# You generally should not modify this.
CXXFLAGS2=-std=c++1y $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD) -pthread
LIBS=-pthread

define color
  @printf '\033[0;34m==== $1 ====\033[0m\n'
endef

# ====================================================================
# Meta rules

.SUFFIXES:
.PHONY: all install clean continuous shell-env fast deps bootstrap-ekam deps update-deps

all: sandstorm-$(BUILD).tar.xz

clean:
	rm -rf bin tmp node_modules bundle shell-build sandstorm-*.tar.xz shell/.meteor/local shell/public/edit.png shell/public/restart.png shell/public/trash.png shell/public/wrench.png shell/public/download.png shell/public/key.png shell/public/close.png shell/public/menu.png shell/public/*-m.png shell/packages/*/.build* shell/packages/*/.npm/package/node_modules
	@(if test -d deps && test ! -h deps; then printf "\033[0;33mTo update dependencies, use: make update-deps\033[0m\n"; fi)

install: sandstorm-$(BUILD)-fast.tar.xz install.sh
	$(call color,install)
	@./install.sh $<

update: sandstorm-$(BUILD)-fast.tar.xz
	$(call color,update local server)
	@sudo sandstorm update $<

fast: sandstorm-$(BUILD)-fast.tar.xz

# ====================================================================
# Dependencies

deps: tmp/.deps

tmp/.deps: deps/capnproto deps/ekam deps/libseccomp deps/libsodium
	@mkdir -p tmp
	@touch tmp/.deps

deps/capnproto:
	$(call color,downloading capnproto)
	@mkdir -p deps
	git clone https://github.com/sandstorm-io/capnproto.git deps/capnproto

deps/ekam:
	$(call color,downloading ekam)
	@mkdir -p deps
	git clone https://github.com/sandstorm-io/ekam.git deps/ekam
	@ln -s .. deps/ekam/deps

deps/libseccomp:
	$(call color,downloading libseccomp)
	@mkdir -p deps
	git clone git://git.code.sf.net/p/libseccomp/libseccomp deps/libseccomp

deps/libsodium:
	$(call color,downloading libsodium)
	@mkdir -p deps
	git clone https://github.com/jedisct1/libsodium.git deps/libsodium

update-deps:
	$(call color,updating all dependencies)
	@(for DEP in capnproto ekam libseccomp libsodium; do cd deps/$$DEP; \
	    echo "pulling $$DEP..."; git pull; cd ../..; done)

# ====================================================================
# Ekam bootstrap and C++ binaries

tmp/ekam-bin: tmp/.deps
	@mkdir -p tmp
	@rm -f tmp/ekam-bin
	@which ekam >/dev/null && ln -s "`which ekam`" tmp/ekam-bin || \
	    (cd deps/ekam && make bin/ekam-bootstrap && \
	     cd ../.. && ln -s ../deps/ekam/bin/ekam-bootstrap tmp/ekam-bin)

tmp/.ekam-run: tmp/ekam-bin src/sandstorm/* tmp/.deps
	$(call color,building sandstorm with ekam)
	@CXX="$(CXX)" CXXFLAGS="$(CXXFLAGS2)" LIBS="$(LIBS)" tmp/ekam-bin -j$(PARALLEL)
	@touch tmp/.ekam-run

continuous:
	@CXX="$(CXX)" CXXFLAGS="$(CXXFLAGS2)" LIBS="$(LIBS)" ekam -j$(PARALLEL) -c -n :41315

bin/spk bin/sandstorm-http-bridge bin/sandstorm-supervisor bin/sandstorm bin/minibox: tmp/.ekam-run
	@test -e "$@"
	@touch "$@"

# ====================================================================
# Front-end shell

shell-env: tmp/.shell-env

tmp/.shell-env: node_modules/sandstorm/grain.capnp shell/public/edit.png shell/public/restart.png shell/public/trash.png shell/public/wrench.png shell/public/download.png shell/public/key.png shell/public/close.png shell/public/menu.png shell/public/edit-m.png shell/public/restart-m.png shell/public/trash-m.png shell/public/wrench-m.png shell/public/download-m.png shell/public/key-m.png shell/public/close-m.png
	@mkdir -p tmp
	@touch tmp/.shell-env

node_modules/sandstorm/grain.capnp: src/sandstorm/*.capnp
	$(call color,copy sandstorm protocols to node_modules/sandstorm)
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/*.capnp node_modules/sandstorm

shell/public/%.png: icons/%.svg
	$(call color,convert $<)
	@convert -scale 24x24 -negate -evaluate multiply 0.87 $< $@
shell/public/%-m.png: icons/%.svg
	@convert -scale 32x32 $< $@

shell-build: shell/client/* shell/server/* shell/shared/* shell/public/* shell/.meteor/packages shell/.meteor/release shell/.meteor/versions tmp/.shell-env
	$(call color,meteor frontend)
	@cd shell && PYTHONPATH=$HOME/.meteor/tools/latest/lib/node_modules/npm/node_modules/node-gyp/gyp/pylib meteor build --directory ../shell-build

# ====================================================================
# Bundle

bundle: bin/spk bin/minibox bin/sandstorm-supervisor bin/sandstorm-http-bridge bin/sandstorm shell-build make-bundle.sh
	$(call color,bundle)
	@./make-bundle.sh

sandstorm-$(BUILD).tar.xz: bundle
	$(call color,compress release bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -9e > sandstorm-$(BUILD).tar.xz

sandstorm-$(BUILD)-fast.tar.xz: bundle
	$(call color,compress fast bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -0 > sandstorm-$(BUILD)-fast.tar.xz

.docker: sandstorm-$(BUILD).tar.xz Dockerfile
	$(call color,docker build)
	@docker build -t sandstorm .
	@touch .docker
