CXX=clang++
CXXFLAGS=-O2 -Wall
VERSION=0.1-dev
CXXFLAGS2=-std=c++1y -Isrc -Itmp $(CXXFLAGS) -DSANDSTORM_VERSION=\"$(VERSION)\"
NODE_INCLUDE=$(HOME)/.meteor/tools/latest/include/node/

.PHONEY: all install uninstall clean environment bundle-dist

all: bin/spk bin/legacy-bridge bin/sandstorm-supervisor node_modules/sandstorm/grain.capnp

clean:
	rm -rf bin tmp node_modules bundle shell-bundle.tar.gz

bin/spk: tmp/genfiles src/sandstorm/spk.c++
	@echo "building bin/spk..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/spk.c++ tmp/sandstorm/*.capnp.c++ -o bin/spk $(CXXFLAGS2) `pkg-config libsodium capnp-rpc --cflags --libs`

bin/legacy-bridge: tmp/genfiles src/sandstorm/legacy-bridge.c++
	@echo "building bin/legacy-bridge..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/legacy-bridge.c++ src/joyent-http/http_parser.c++ tmp/sandstorm/*.capnp.c++ -o bin/legacy-bridge $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

bin/sandstorm-supervisor: tmp/genfiles src/sandstorm/supervisor-main.c++
	@echo "building bin/sandstorm-supervisor..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/supervisor-main.c++ tmp/sandstorm/*.capnp.c++ -o bin/sandstorm-supervisor $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

bin/run-bundle: tmp/genfiles src/sandstorm/run-bundle.c++
	@echo "building bin/run-bundle..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/run-bundle.c++ -o bin/run-bundle -static $(CXXFLAGS2) `pkg-config capnp --cflags --libs`

node_modules/sandstorm/grain.capnp: src/sandstorm/*.capnp
	@echo "copying sandstorm protocols to node_modules/sandstorm..."
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/*.capnp node_modules/sandstorm

tmp/genfiles: src/sandstorm/*.capnp
	@echo "generating capnp files..."
	@mkdir -p tmp
	@capnp compile --src-prefix=src -oc++:tmp  src/sandstorm/*.capnp
	@touch tmp/genfiles

install: all
	@(test "x$(SANDSTORM_USER)" != x || (echo "Please set SANDSTORM_USER to the user:group under which Sandstorm will run.  For example:" >&2 && echo "    sudo make install SANDSTORM_USER=someuser:somegroup" >&2 && false));
	cp bin/spk /usr/local/bin
	cp bin/sandstorm-supervisor /usr/local/bin
	mkdir -p /usr/local/include/sandstorm
	cp src/sandstorm/*.capnp /usr/local/include/sandstorm
	chmod +s /usr/local/bin/sandstorm-supervisor
	mkdir -p /var/sandstorm /var/sandstorm/apps /var/sandstorm/downloads /var/sandstorm/grains
	chown -R $(SANDSTORM_USER) /var/sandstorm

uninstall:
	rm -rf /usr/local/bin/sandstorm-supervisor /usr/local/bin/spk

# ========================================================================================
# Mega Package
#
# Builds a complete downloadable chroot environment containing Sandstorm.  This is not
# part of "make all" because most people don't actually want to build this.

shell-bundle.tar.gz: shell/smart.* shell/client/* shell/server/* shell/shared/* shell/public/* shell/.meteor/packages shell/.meteor/release
	@echo "bundling meteor frontend..."
	@cd shell && mrt bundle ../shell-bundle.tar.gz

bundle: bin/spk bin/run-bundle shell-bundle.tar.gz make-bundle.sh
	./make-bundle.sh

sandstorm-bundle-$(VERSION).tar.xz: bundle
	tar Jcf sandstorm-bundle-$(VERSION).tar.xz --transform="s,^bundle/,sandstorm-bundle-$(VERSION)/," bundle

bundle-dist: sandstorm-bundle-$(VERSION).tar.xz

