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
CC=clang
CXX=clang++
CFLAGS=-O2 -Wall
CXXFLAGS=$(CFLAGS)
BUILD=0
PARALLEL=$(shell nproc)

# You generally should not modify this.
# TODO(cleanup): -fPIC is unfortunate since most of our code is static binaries
#   but we also need to build a .node module which is a shared library, and it
#   needs to include all the Cap'n Proto code. Do we double-compile or do we
#   just accept it? Perhaps it's for the best since we probably should build
#   position-independent executables for security reasons?
METEOR_DEV_BUNDLE=$(shell ./find-meteor-dev-bundle.sh)
NODEJS=$(METEOR_DEV_BUNDLE)/bin/node
NODE_HEADERS=$(METEOR_DEV_BUNDLE)/include/node
WARNINGS=-Wall -Wextra -Wglobal-constructors -Wno-sign-compare -Wno-unused-parameter
CXXFLAGS2=-std=c++1y $(WARNINGS) $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD) -pthread -fPIC -I$(NODE_HEADERS)
LIBS=-pthread

define color
  printf '\033[0;34m==== $1 ====\033[0m\n'
endef


IMAGES= \
    shell/public/battery.svg \
    shell/public/close.svg \
    shell/public/copy.svg \
    shell/public/debug.svg \
    shell/public/download.svg \
    shell/public/down.svg \
    shell/public/email.svg \
    shell/public/install.svg \
    shell/public/key.svg \
    shell/public/link.svg \
    shell/public/menu.svg \
    shell/public/notification.svg \
    shell/public/people.svg \
    shell/public/restart.svg \
    shell/public/restore.svg \
    shell/public/settings.svg \
    shell/public/share.svg \
    shell/public/trash.svg \
    shell/public/upload.svg \
    shell/public/up.svg \
                             \
    shell/public/close-m.svg \
    shell/public/copy-m.svg \
    shell/public/debug-m.svg \
    shell/public/download-m.svg \
    shell/public/email-m.svg \
    shell/public/key-m.svg \
    shell/public/link-m.svg \
    shell/public/notification-m.svg \
    shell/public/people-m.svg \
    shell/public/restart-m.svg \
    shell/public/settings-m.svg \
    shell/public/share-m.svg \
    shell/public/trash-m.svg

# ====================================================================
# Meta rules

.SUFFIXES:
.PHONY: all install clean continuous shell-env fast deps bootstrap-ekam deps update-deps test installer-test app-index-dev

all: sandstorm-$(BUILD).tar.xz

clean:
	rm -rf bin tmp node_modules bundle shell-build sandstorm-*.tar.xz shell/.meteor/local $(IMAGES) shell/client/changelog.html shell/packages/*/.build* shell/packages/*/.npm/package/node_modules
	@(if test -d deps && test ! -h deps; then printf "\033[0;33mTo update dependencies, use: make update-deps\033[0m\n"; fi)

install: sandstorm-$(BUILD)-fast.tar.xz install.sh
	@$(call color,install)
	@./install.sh $<

update: sandstorm-$(BUILD)-fast.tar.xz
	@$(call color,update local server)
	@sudo sandstorm update $<

fast: sandstorm-$(BUILD)-fast.tar.xz

test: sandstorm-$(BUILD)-fast.tar.xz
	tests/run-local.sh sandstorm-$(BUILD)-fast.tar.xz

installer-test:
	(cd installer-tests && bash prepare-for-tests.sh && SLOW_TEXT_TIMEOUT=60 python run_tests.py --rsync --uninstall-first --halt-afterward)

# ====================================================================
# Dependencies

# We list remotes so that if projects move hosts, we can pull from their new
# canonical location.
REMOTE_capnproto=https://github.com/sandstorm-io/capnproto.git
REMOTE_ekam=https://github.com/sandstorm-io/ekam.git
REMOTE_libseccomp=https://github.com/seccomp/libseccomp
REMOTE_libsodium=https://github.com/jedisct1/libsodium.git
REMOTE_node-capnp=https://github.com/kentonv/node-capnp.git

deps: tmp/.deps

tmp/.deps: deps/capnproto deps/ekam deps/libseccomp deps/libsodium deps/node-capnp
	@mkdir -p tmp
	@touch tmp/.deps

deps/capnproto:
	@$(call color,downloading capnproto)
	@mkdir -p deps
	git clone $(REMOTE_capnproto) deps/capnproto

deps/ekam:
	@$(call color,downloading ekam)
	@mkdir -p deps
	git clone $(REMOTE_ekam) deps/ekam
	@ln -s .. deps/ekam/deps

deps/libseccomp:
	@$(call color,downloading libseccomp)
	@mkdir -p deps
	git clone $(REMOTE_libseccomp) deps/libseccomp

deps/libsodium:
	@$(call color,downloading libsodium)
	@mkdir -p deps
	git clone $(REMOTE_libsodium) deps/libsodium

deps/node-capnp:
	@$(call color,downloading node-capnp)
	@mkdir -p deps
	git clone $(REMOTE_node-capnp) deps/node-capnp

update-deps:
	@$(call color,updating all dependencies)
	@$(foreach DEP,capnproto ekam libseccomp libsodium node-capnp, \
	    cd deps/$(DEP) && \
	    echo "pulling $(DEP)..." && \
	    git pull $(REMOTE_$(DEP)) && \
	    cd ../..;)

# ====================================================================
# Ekam bootstrap and C++ binaries

tmp/ekam-bin: tmp/.deps
	@mkdir -p tmp
	@rm -f tmp/ekam-bin
	@which ekam >/dev/null && ln -s "`which ekam`" tmp/ekam-bin || \
	    (cd deps/ekam && $(MAKE) bin/ekam-bootstrap && \
	     cd ../.. && ln -s ../deps/ekam/bin/ekam-bootstrap tmp/ekam-bin)

tmp/.ekam-run: tmp/ekam-bin src/sandstorm/* tmp/.deps
	@$(call color,building sandstorm with ekam)
	@CC="$(CC)" CXX="$(CXX)" CFLAGS="$(CFLAGS)" CXXFLAGS="$(CXXFLAGS2)" \
	    LIBS="$(LIBS)" NODEJS=$(NODEJS) tmp/ekam-bin -j$(PARALLEL) || \
	    ($(call color,build failed. You might need to: make update-deps) && false)
	@touch tmp/.ekam-run

continuous:
	@CC="$(CC)" CXX="$(CXX)" CFLAGS="$(CFLAGS)" CXXFLAGS="$(CXXFLAGS2)" \
	    LIBS="$(LIBS)" NODEJS=$(NODEJS) ekam -j$(PARALLEL) -c -n :41315 || \
	    ($(call color,You probably need to install ekam and put it on your path; see github.com/sandstorm-io/ekam) && false)

# ====================================================================
# Front-end shell

shell-env: tmp/.shell-env

# Note that we need Ekam to build node_modules before we can run Meteor, hence
# the dependency on tmp/.ekam-run.
tmp/.shell-env: tmp/.ekam-run $(IMAGES) shell/client/changelog.html
	@mkdir -p tmp
	@touch tmp/.shell-env
	@mkdir -p node_modules/capnp
	@bash -O extglob -c 'cp src/capnp/!(*test*).capnp node_modules/capnp'

shell/client/changelog.html: CHANGELOG.md
	@mkdir -p tmp
	@echo '<template name="changelog">' > tmp/changelog.html
	@markdown CHANGELOG.md >> tmp/changelog.html
	@echo '</template>' >> tmp/changelog.html
	@cp tmp/changelog.html shell/client/changelog.html

shell/public/%.svg: icons/%.svg
	@$(call color,color for dark background $<)
	@sed -e 's/#000000/#CCCCCC/g' < $< > $@

shell/public/%-m.svg: icons/%.svg
	@$(call color,color for light background $<)
	@# Leave as black.
	@cp $< $@

shell-build: shell/lib/* shell/client/* shell/server/* shell/shared/* shell/public/* shell/packages/* shell/packages/*/* shell/.meteor/packages shell/.meteor/release shell/.meteor/versions tmp/.shell-env
	@$(call color,meteor frontend)
	@OLD=`pwd` && cd shell && PYTHONPATH=$$HOME/.meteor/tools/latest/lib/node_modules/npm/node_modules/node-gyp/gyp/pylib meteor build --directory "$$OLD/shell-build"

# ====================================================================
# Bundle

bundle: tmp/.ekam-run shell-build make-bundle.sh meteor-bundle-main.js
	@$(call color,bundle)
	@./make-bundle.sh

sandstorm-$(BUILD).tar.xz: bundle
	@$(call color,compress release bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -9e > sandstorm-$(BUILD).tar.xz

sandstorm-$(BUILD)-fast.tar.xz: bundle
	@$(call color,compress fast bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -0 --threads=0 > sandstorm-$(BUILD)-fast.tar.xz

.docker: Dockerfile
	@$(call color,docker build)
	@docker build -t sandstorm .
	@touch .docker

# ====================================================================
# app-index.spk

# This is currently really really hacky because spk is not good at using package definition file
# that is not located at the root of the source tree. In particular it is hard for the package
# definition file (living in the src tree) to refer to the `app-index` binary (living in the
# tmp tree).
#
# TODO(cleanup): Make spk better so that it can handle this.

app-index.spk: tmp/.ekam-run
	@cp src/sandstorm/app-index/app-index.capnp tmp/sandstorm/app-index/app-index.capnp
	@cp src/sandstorm/app-index/review.html tmp/sandstorm/app-index/review.html
	spk pack -Isrc -Itmp -ptmp/sandstorm/app-index/app-index.capnp:pkgdef app-index.spk

app-index-dev: tmp/.ekam-run
	@cp src/sandstorm/app-index/app-index.capnp tmp/sandstorm/app-index/app-index.capnp
	@cp src/sandstorm/app-index/review.html tmp/sandstorm/app-index/review.html
	spk dev -Isrc -Itmp -ptmp/sandstorm/app-index/app-index.capnp:pkgdef
