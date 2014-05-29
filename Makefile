# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
# All rights reserved.
#
# This file is part of the Sandstorm platform implementation.
#
# Sandstorm is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# Sandstorm is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public
# License along with Sandstorm.  If not, see
# <http://www.gnu.org/licenses/>.

# You may override the following vars on the command line to suit
# your config.
CXX=clang++
CXXFLAGS=-O2 -Wall
BUILD=0

# You generally should not modify these.
CXXFLAGS2=-std=c++1y -Isrc -Itmp $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD)
NODE_INCLUDE=$(HOME)/.meteor/tools/latest/include/node/

# TODO(cleanup): Originally each command here was defined in one file and there
#   was really no shared code. That seems to have changed. Perhaps it's time
#   to separate compilation and linking. 

.PHONEY: all install clean shell-env

all: sandstorm-$(BUILD).tar.xz

clean:
	rm -rf bin tmp node_modules bundle shell-bundle.tar.gz sandstorm-*.tar.xz shell/public/edit.png shell/public/trash.png shell/public/wrench.png

install: sandstorm-$(BUILD).tar.xz install.sh
	@./install.sh sandstorm-$(BUILD).tar.xz

shell-env: node_modules/sandstorm/grain.capnp shell/public/edit.png shell/public/trash.png shell/public/wrench.png

update: sandstorm-$(BUILD).tar.xz
	sudo service sandstorm update $(PWD)/sandstorm-$(BUILD).tar.xz

bin/spk: tmp/genfiles src/sandstorm/spk.c++ src/sandstorm/fuse.c++ src/sandstorm/union-fs.c++ src/sandstorm/send-fd.c++
	@echo "building bin/spk..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/spk.c++ src/sandstorm/fuse.c++ src/sandstorm/union-fs.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/spk -static $(CXXFLAGS2) -lcapnpc `pkg-config libsodium capnp-rpc --cflags --libs`

bin/sandstorm-http-bridge: tmp/genfiles src/sandstorm/sandstorm-http-bridge.c++
	@echo "building bin/sandstorm-http-bridge..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/sandstorm-http-bridge.c++ src/joyent-http/http_parser.c++ tmp/sandstorm/*.capnp.c++ -o bin/sandstorm-http-bridge -static $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

bin/sandstorm-supervisor: tmp/genfiles src/sandstorm/supervisor-main.c++ src/sandstorm/send-fd.c++
	@echo "building bin/sandstorm-supervisor..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/supervisor-main.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/sandstorm-supervisor $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

node_modules/sandstorm/grain.capnp: src/sandstorm/*.capnp
	@echo "copying sandstorm protocols to node_modules/sandstorm..."
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/*.capnp node_modules/sandstorm

tmp/genfiles: src/sandstorm/*.capnp
	@echo "generating capnp files..."
	@mkdir -p tmp
	@capnp compile --src-prefix=src -oc++:tmp  src/sandstorm/*.capnp
	@touch tmp/genfiles

bin/run-bundle: src/sandstorm/run-bundle.c++ src/sandstorm/send-fd.c++ tmp/genfiles
	@echo "building bin/run-bundle..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/run-bundle.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/run-bundle -static $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

shell/public/%.png: icons/%.svg
	convert -scale 24x24 -negate -alpha shape -evaluate multiply 0.87 $< $@

shell-bundle.tar.gz: shell/smart.* shell/client/* shell/server/* shell/shared/* shell/public/* shell/.meteor/packages shell/.meteor/release shell-env
	@echo "bundling meteor frontend..."
	@cd shell && mrt bundle ../shell-bundle.tar.gz > /dev/null

bundle: bin/spk bin/sandstorm-supervisor bin/sandstorm-http-bridge bin/run-bundle shell-bundle.tar.gz make-bundle.sh node_modules/sandstorm/grain.capnp
	./make-bundle.sh

sandstorm-$(BUILD).tar.xz: bundle
	tar Jcf sandstorm-$(BUILD).tar.xz --transform="s,^bundle,sandstorm-$(BUILD)," bundle
