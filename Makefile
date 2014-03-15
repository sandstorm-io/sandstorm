CXX=clang++
CXXFLAGS=-O2 -Wall
CXXFLAGS2=-std=c++1y -Isrc -Itmp $(CXXFLAGS)
NODE_INCLUDE=$(HOME)/.meteor/tools/latest/include/node/

.PHONEY: all clean

all: bin/spk bin/legacy-bridge bin/sandstorm-supervisor node_modules/sandstorm/v8capnp.node node_modules/sandstorm/capnp.js node_modules/sandstorm/grain.capnp

clean:
	rm -rf bin tmp node_modules

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

node_modules/sandstorm/v8capnp.node: src/sandstorm/v8capnp.c++
	@echo "building node_modules/sandstorm/v8capnp.node..."
	@mkdir -p node_modules/sandstorm
	@$(CXX) -shared -fPIC src/sandstorm/v8capnp.c++ -o node_modules/sandstorm/v8capnp.node $(CXXFLAGS2) -lcapnpc `pkg-config capnp-rpc --cflags --libs` -I$(NODE_INCLUDE)

node_modules/sandstorm/capnp.js: src/sandstorm/capnp.js
	@echo "copying node_modules/sandstorm/capnp.js..."
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/capnp.js node_modules/sandstorm/capnp.js

node_modules/sandstorm/grain.capnp: src/sandstorm/*.capnp
	@echo "copying sandstorm protocols to node_modules/sandstorm..."
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/*.capnp node_modules/sandstorm

tmp/genfiles: src/sandstorm/*.capnp
	@echo "generating capnp files..."
	@mkdir -p tmp
	@capnp compile --src-prefix=src -oc++:tmp  src/sandstorm/*.capnp
	@touch tmp/genfiles

