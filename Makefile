CXX=clang++
CXXFLAGS=-O2 -Wall
BUILD=0
CXXFLAGS2=-std=c++1y -Isrc -Itmp $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD)
NODE_INCLUDE=$(HOME)/.meteor/tools/latest/include/node/

# TODO(cleanup): Originally each command here was defined in one file and there
#   was really no shared code. That seems to have changed. Perhaps it's time
#   to separate compilation and linking. 

.PHONEY: all install uninstall clean environment bundle-dist

all: bin/spk bin/legacy-bridge bin/sandstorm-supervisor node_modules/sandstorm/grain.capnp

clean:
	rm -rf bin tmp node_modules bundle shell-bundle.tar.gz sandstorm-*.tar.xz

bin/spk: tmp/genfiles src/sandstorm/spk.c++ src/sandstorm/fuse.c++ src/sandstorm/union-fs.c++ src/sandstorm/send-fd.c++
	@echo "building bin/spk..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/spk.c++ src/sandstorm/fuse.c++ src/sandstorm/union-fs.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/spk $(CXXFLAGS2) -lcapnpc `pkg-config libsodium capnp-rpc --cflags --libs`

bin/legacy-bridge: tmp/genfiles src/sandstorm/legacy-bridge.c++
	@echo "building bin/legacy-bridge..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/legacy-bridge.c++ src/joyent-http/http_parser.c++ tmp/sandstorm/*.capnp.c++ -o bin/legacy-bridge $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

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

bin/run-bundle: src/sandstorm/run-bundle.c++ src/sandstorm/send-fd.c++ tmp/genfiles
	@echo "building bin/run-bundle..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/run-bundle.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/run-bundle -static $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

shell-bundle.tar.gz: shell/smart.* shell/client/* shell/server/* shell/shared/* shell/public/* shell/.meteor/packages shell/.meteor/release
	@echo "bundling meteor frontend..."
	@cd shell && mrt bundle ../shell-bundle.tar.gz > /dev/null

bundle: bin/spk bin/sandstorm-supervisor bin/run-bundle shell-bundle.tar.gz make-bundle.sh
	./make-bundle.sh

sandstorm-$(BUILD).tar.xz: bundle
	tar Jcf sandstorm-$(BUILD).tar.xz --transform="s,^bundle,sandstorm-$(BUILD)," bundle

bundle-dist: sandstorm-$(BUILD).tar.xz

