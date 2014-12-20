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

# You generally should not modify this.
CXXFLAGS2=-std=c++1y -Isrc -Itmp $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD) `pkg-config capnp-rpc --cflags`

define color
  @printf '\033[0;34m==== $1 ====\033[0m\n'
endef

# ====================================================================
# Meta rules

.SUFFIXES:
.PHONY: all install clean shell-env fast

all: sandstorm-$(BUILD).tar.xz

clean:
	rm -rf bin tmp node_modules bundle shell-build sandstorm-*.tar.xz shell/public/edit.png shell/public/restart.png shell/public/trash.png shell/public/wrench.png shell/public/download.png shell/public/key.png shell/public/close.png shell/public/menu.png shell/public/*-m.png .shell-env shell/packages/*/.build* shell/packages/*/.npm/package/node_modules tmp/sandstorm/ip_tables.h

install: sandstorm-$(BUILD)-fast.tar.xz install.sh
	$(call color,install)
	@./install.sh $<

update: sandstorm-$(BUILD)-fast.tar.xz
	$(call color,update local server)
	@sudo sandstorm update $<

fast: sandstorm-$(BUILD)-fast.tar.xz

# ====================================================================
# Protocols

PROTOS := $(wildcard src/sandstorm/*.capnp)

tmp/protos: $(PROTOS)
	$(call color,generating capnp files)
	@mkdir -p tmp
	@capnp compile --src-prefix=src -oc++:tmp  src/sandstorm/*.capnp
	@touch tmp/protos

tmp/sandstorm/protos.a: $(PROTOS:src/%.capnp=tmp/%.capnp.o)
	$(call color,link sandstorm/protos.a)
	@ar rcs $@ $^
	@ranlib $@

# ====================================================================
# C++ Support

# This one Linux header has an inline function that depends on C's
# non-type-safe pointers and GCC's void-pointer-arithmetic extension.
# Nuke it. We don't use the function anyway.
tmp/sandstorm/ip_tables.h: /usr/include/linux/netfilter_ipv4/ip_tables.h
	$(call color,fix ip_tables.h)
	@mkdir -p tmp/sandstorm
	@echo "// From <linux/netfilter_ipv4/ip_tables.h>, fixed to compile as C++" > $@
	@sed -e 's,(void [*])e [+] e->target_offset;,nullptr;  // non-C++-compliant code removed for Sandstorm,g' $< >> $@

tmp/%.o: src/%.c++ tmp/protos tmp/sandstorm/ip_tables.h
	$(call color,compile $*.c++)
	@mkdir -p `dirname $@`
	@$(CXX) $(CXXFLAGS2) -c src/$*.c++ -o $@ -MD

tmp/%.capnp.o: tmp/protos
	$(call color,compile $*.capnp.c++)
	@mkdir -p `dirname $@`
	@$(CXX) $(CXXFLAGS2) -c tmp/$*.capnp.c++ -o $@ -MD

-include tmp/sandstorm/*.d

# ====================================================================
# C++ Binaries

bin/spk: tmp/sandstorm/spk.o \
         tmp/sandstorm/fuse.o \
         tmp/sandstorm/union-fs.o \
         tmp/sandstorm/send-fd.o \
         tmp/sandstorm/protos.a
	$(call color,link spk)
	@mkdir -p bin
	@$(CXX) $^ -o $@ -static $(CXXFLAGS2) -lcapnpc `pkg-config libsodium capnp-rpc --libs`

bin/sandstorm-http-bridge: tmp/sandstorm/sandstorm-http-bridge.o \
                           tmp/joyent-http/http_parser.o \
                           tmp/sandstorm/protos.a
	$(call color,link sandstorm-http-bridge)
	@mkdir -p bin
	@$(CXX) $^ -o $@ -static $(CXXFLAGS2) `pkg-config capnp-rpc --libs`

bin/sandstorm-supervisor: tmp/sandstorm/supervisor-main.o \
                          tmp/sandstorm/send-fd.o \
                          tmp/sandstorm/protos.a
	$(call color,link sandstorm-supervisor)
	@mkdir -p bin
	@$(CXX) $^ -o $@ $(CXXFLAGS2) `pkg-config libseccomp capnp-rpc --libs`

bin/run-bundle: tmp/sandstorm/run-bundle.o \
                tmp/sandstorm/send-fd.o \
                tmp/sandstorm/protos.a
	$(call color,link run-bundle)
	@mkdir -p bin
	@$(CXX) $^ -o $@ -static $(CXXFLAGS2) `pkg-config capnp-rpc --libs`

bin/minibox: tmp/sandstorm/minibox.o
	$(call color,link minibox)
	@mkdir -p bin
	@$(CXX) $^ -o $@ $(CXXFLAGS2) `pkg-config capnp --libs`

# ====================================================================
# Front-end shell

shell-env: .shell-env

.shell-env: node_modules/sandstorm/grain.capnp shell/public/edit.png shell/public/restart.png shell/public/trash.png shell/public/wrench.png shell/public/download.png shell/public/key.png shell/public/close.png shell/public/menu.png shell/public/edit-m.png shell/public/restart-m.png shell/public/trash-m.png shell/public/wrench-m.png shell/public/download-m.png shell/public/key-m.png shell/public/close-m.png
	@touch .shell-env

node_modules/sandstorm/grain.capnp: src/sandstorm/*.capnp
	$(call color,copy sandstorm protocols to node_modules/sandstorm)
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/*.capnp node_modules/sandstorm

shell/public/%.png: icons/%.svg
	$(call color,convert $<)
	@convert -scale 24x24 -negate -evaluate multiply 0.87 $< $@
shell/public/%-m.png: icons/%.svg
	@convert -scale 32x32 $< $@

shell-build: shell/client/* shell/server/* shell/shared/* shell/public/* shell/.meteor/packages shell/.meteor/release shell/.meteor/versions .shell-env
	$(call color,meteor frontend)
	@cd shell && PYTHONPATH=$HOME/.meteor/tools/latest/lib/node_modules/npm/node_modules/node-gyp/gyp/pylib meteor build --directory ../shell-build

# ====================================================================
# Bundle

bundle: bin/spk bin/minibox bin/sandstorm-supervisor bin/sandstorm-http-bridge bin/run-bundle shell-build make-bundle.sh
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
