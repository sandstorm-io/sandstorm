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
CC=$(shell pwd)/deps/llvm-build/Release+Asserts/bin/clang
CXX=$(shell pwd)/deps/llvm-build/Release+Asserts/bin/clang++
CFLAGS=-O2 -Wall -g
CXXFLAGS=$(CFLAGS)
BUILD=0
PARALLEL=$(shell nproc)
LIBS=
EKAM=ekam

# You generally should not modify this.
# TODO(cleanup): -fPIC is unfortunate since most of our code is static binaries
#   but we also need to build a .node module which is a shared library, and it
#   needs to include all the Cap'n Proto code. Do we double-compile or do we
#   just accept it? Perhaps it's for the best since we probably should build
#   position-independent executables for security reasons?
# NOTE: Emperically -DKJ_STD_COMPAT appears to be necessary on recent ditros
#   (as of Jan 2020), notably Debian Sid, Fedora 30 and Archlinux. We're not
#   entirely sure what changed, but this seems like a backwards incompatibility
#   in libstdc++. See also issue #3171.
METEOR_DEV_BUNDLE=$(shell ./find-meteor-dev-bundle.sh)
METEOR_SPK_VERSION=0.5.1
METEOR_SPK=$(PWD)/meteor-spk-$(METEOR_SPK_VERSION)/meteor-spk
NODEJS=$(METEOR_DEV_BUNDLE)/bin/node
NODE_HEADERS=$(METEOR_DEV_BUNDLE)/include/node
WARNINGS=-Wall -Wextra -Wglobal-constructors -Wno-sign-compare -Wno-unused-parameter
CXXFLAGS2=-std=c++1z $(WARNINGS) $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD) -DKJ_HAS_OPENSSL -DKJ_HAS_ZLIB -DKJ_HAS_LIBDL -pthread -fPIC -I$(NODE_HEADERS) -DKJ_STD_COMPAT
CFLAGS2=$(CFLAGS) -pthread -fPIC -DKJ_STD_COMPAT
# -lrt is not used by sandstorm itself, but the test app uses it. It would be
#  nice if we could not link everything against it.
LIBS2=$(LIBS) deps/libsodium/build/src/libsodium/.libs/libsodium.a deps/boringssl/build/ssl/libssl.a deps/boringssl/build/crypto/libcrypto.a -lz -ldl -pthread -lrt

define color
  printf '\033[0;34m==== $1 ====\033[0m\n'
endef


IMAGES= \
    shell/public/apps.svg \
    shell/public/appmarket.svg \
    shell/public/battery.svg \
    shell/public/bug.svg \
    shell/public/close.svg \
    shell/public/copy.svg \
    shell/public/debug.svg \
    shell/public/download.svg \
    shell/public/down.svg \
    shell/public/email.svg \
    shell/public/github.svg \
    shell/public/google.svg \
    shell/public/key.svg \
    shell/public/ldap.svg \
    shell/public/link.svg \
    shell/public/menu.svg \
    shell/public/notification.svg \
    shell/public/open-grain.svg \
    shell/public/openid.svg \
    shell/public/people.svg \
    shell/public/question-727272.svg \
    shell/public/question-a9a9a9.svg \
    shell/public/restart.svg \
    shell/public/restore.svg \
    shell/public/settings.svg \
    shell/public/source.svg \
    shell/public/share.svg \
    shell/public/search.svg \
    shell/public/trash.svg \
    shell/public/troubleshoot.svg \
    shell/public/upload.svg \
    shell/public/up.svg \
    shell/public/web.svg \
                             \
    shell/public/add-credit-m.svg \
    shell/public/add-email-m.svg \
    shell/public/apps-m.svg \
    shell/public/appmarket-m.svg \
    shell/public/bug-m.svg \
    shell/public/clipboard-m.svg \
    shell/public/close-m.svg \
    shell/public/copy-m.svg \
    shell/public/credit-m.svg \
    shell/public/down-m.svg \
    shell/public/debug-m.svg \
    shell/public/download-m.svg \
    shell/public/email-m.svg \
    shell/public/github-m.svg \
    shell/public/key-m.svg \
    shell/public/ldap-m.svg \
    shell/public/keybase-m.svg \
    shell/public/link-m.svg \
    shell/public/notification-m.svg \
    shell/public/open-grain-m.svg \
    shell/public/people-m.svg \
    shell/public/pronoun-m.svg \
    shell/public/restart-m.svg \
    shell/public/settings-m.svg \
    shell/public/share-m.svg \
    shell/public/source-m.svg \
    shell/public/trash-m.svg \
    shell/public/troubleshoot-m.svg \
    shell/public/twitter-m.svg \
    shell/public/up-m.svg \
    shell/public/unlink-m.svg \
    shell/public/web-m.svg \
                                  \
    shell/public/github-color.svg \
    shell/public/google-color.svg \
    shell/public/openid-color.svg \
    shell/public/email-494949.svg \
    shell/public/close-FFFFFF.svg \
                                  \
    shell/public/install-714DAA.svg \
    shell/public/install-896AC6.svg \
    shell/public/plus-6A237C.svg \
    shell/public/plus-9E40B5.svg \
    shell/public/upload-B7B7B7.svg \
    shell/public/upload-5D5D5D.svg \
    shell/public/restore-B7B7B7.svg \
    shell/public/restore-5D5D5D.svg

# ====================================================================
# Meta rules

.SUFFIXES:
.PHONY: all install clean clean-deps ci-clean continuous shell-env fast deps bootstrap-ekam update-deps test installer-test app-index-dev lint

all: sandstorm-$(BUILD).tar.xz

clean: ci-clean
	rm -rf shell/node_modules shell/.meteor/local $(IMAGES) shell/imports/client/changelog.html *.sig *.update-sig icons/node_modules shell/public/icons/icons-*.eot shell/public/icons/icons-*.ttf shell/public/icons/icons-*.svg shell/public/icons/icons-*.woff icons/package-lock.json tests/package-lock.json deps/llvm-build meteor-testapp/node_modules
	@# Note: capnproto, libseccomp, and node-capnp are integrated into the common build.
	cd deps/ekam && make clean
	rm -rf deps/libsodium/build
	rm -rf deps/boringssl/build

ci-clean:
	@# Clean only the stuff that we want to clean between CI builds.
	rm -rf bin tmp node_modules bundle shell-build sandstorm-*.tar.xz
	rm -rf tests/assets/meteor-testapp.spk meteor-testapp/.meteor-spk

install: sandstorm-$(BUILD)-fast.tar.xz install.sh
	@$(call color,install)
	@./install.sh $<

update: sandstorm-$(BUILD)-fast.tar.xz
	@$(call color,update local server)
	@sudo sandstorm update $<

fast: sandstorm-$(BUILD)-fast.tar.xz

test: sandstorm-$(BUILD)-fast.tar.xz test-app.spk tests/assets/meteor-testapp.spk
	tests/run-local.sh sandstorm-$(BUILD)-fast.tar.xz test-app.spk
lint: shell-env
	cd shell && meteor npm run lint

installer-test:
	(cd installer-tests && bash prepare-for-tests.sh && PYTHONUNBUFFERED=yes TERM=xterm SLOW_TEXT_TIMEOUT=120 ~/.local/bin/stodgy-tester --plugin stodgy_tester.plugins.sandstorm_installer_tests --on-vm-start=uninstall_sandstorm --rsync)

stylecheck:
	@which jscs > /dev/null 2>&1 || ( echo "You need jscs installed. Consider installing with e.g."; echo ; echo "npm -g install jscs"; echo ; exit 1)
	cd shell && jscs .

# ====================================================================
# Dependencies

DEPS=capnproto ekam libseccomp libsodium node-capnp boringssl clang

# We list remotes so that if projects move hosts, we can pull from their new
# canonical location.
REMOTE_capnproto=https://github.com/sandstorm-io/capnproto.git master
REMOTE_ekam=https://github.com/sandstorm-io/ekam.git master
REMOTE_libseccomp=https://github.com/seccomp/libseccomp master
REMOTE_libsodium=https://github.com/jedisct1/libsodium.git stable
REMOTE_node-capnp=https://github.com/kentonv/node-capnp.git node10
REMOTE_boringssl=https://boringssl.googlesource.com/boringssl master
REMOTE_clang=https://chromium.googlesource.com/chromium/src/tools/clang.git master

deps/capnproto/.git:
	@# Probably user forgot to checkout submodules. Do it for them.
	@$(call color,"fetching submodules")
	git submodule update --init --recursive

deps: tmp/.deps

tmp/.deps: | deps/capnproto/.git
	@mkdir -p tmp
	@touch tmp/.deps

update-deps:
	@$(call color,updating all dependencies)
	@$(foreach DEP,$(DEPS), \
	    cd deps/$(DEP) && \
	    echo "pulling $(DEP)..." && \
	    git fetch $(REMOTE_$(DEP)) && \
	    git rebase FETCH_HEAD && \
	    cd ../..;)

# ====================================================================
# Get Clang
#
# We use the prebuilt Clang binaries from the Chromium project. We do this because I've observed
# Sandstorm contributors have a very hard time installing up-to-date versions of Clang on typcial
# Linux distros. Ubuntu and Debian ship with outdated versions of Clang, which means people have
# to install Clang from the LLVM apt repo. However, people struggle to set that up, and the repo
# has been known to randomly break from time to time. OTOH, the Chromium project maintains a very
# up-to-date version of Clang which is used to build Chrome, conveniently maintained as a git repo
# (which we can pin to a commit) containing a nice script that will download precompiled binaries.

deps/llvm-build: | tmp/.deps
	@$(call color,downloading Clang binaries from Chromium project)
	@deps/clang/scripts/update.py
	@mv third_party/llvm-build deps
	@rmdir third_party

# ====================================================================
# build BoringSSL

deps/boringssl/build/Makefile: | tmp/.deps deps/llvm-build
	@$(call color,configuring BoringSSL)
	@mkdir -p deps/boringssl/build
	cd deps/boringssl/build && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$(CC)" -DCMAKE_CXX_COMPILER="$(CXX)" -DCMAKE_C_FLAGS="-fPIE" -DCMAKE_CXX_FLAGS="-fPIE" ..

deps/boringssl/build/ssl/libssl.a: deps/boringssl/build/Makefile
	@$(call color,building BoringSSL)
	cd deps/boringssl/build && make -j$(PARALLEL)

# ====================================================================
# build libsodium

deps/libsodium/build/Makefile: | tmp/.deps deps/llvm-build
	@$(call color,configuring libsodium)
	@mkdir -p deps/libsodium/build
	cd deps/libsodium/build && ../configure --disable-shared CC="$(CC)"

deps/libsodium/build/src/libsodium/.libs/libsodium.a: deps/libsodium/build/Makefile
	@$(call color,building libsodium)
	cd deps/libsodium/build && make -j$(PARALLEL)

# ====================================================================
# Ekam bootstrap and C++ binaries

tmp/ekam-bin: tmp/.deps
	@mkdir -p tmp
	@rm -f tmp/ekam-bin
	@which ekam >/dev/null && ln -s "`which ekam`" tmp/ekam-bin || \
	    (cd deps/ekam && $(MAKE) bin/ekam-bootstrap && \
	     cd ../.. && ln -s ../deps/ekam/bin/ekam-bootstrap tmp/ekam-bin)

tmp/.ekam-run: tmp/ekam-bin src/sandstorm/* tmp/.deps deps/boringssl/build/ssl/libssl.a deps/libsodium/build/src/libsodium/.libs/libsodium.a | deps/llvm-build
	@$(call color,building sandstorm with ekam)
	@CC="$(CC)" CXX="$(CXX)" CFLAGS="$(CFLAGS2)" CXXFLAGS="$(CXXFLAGS2)" \
	    LIBS="$(LIBS2)" NODEJS=$(NODEJS) tmp/ekam-bin -j$(PARALLEL)
	@touch tmp/.ekam-run

continuous: tmp/.deps deps/boringssl/build/ssl/libssl.a deps/libsodium/build/src/libsodium/.libs/libsodium.a | deps/llvm-build
	@CC="$(CC)" CXX="$(CXX)" CFLAGS="$(CFLAGS2)" CXXFLAGS="$(CXXFLAGS2)" \
	    LIBS="$(LIBS2)" NODEJS=$(NODEJS) $(EKAM) -j$(PARALLEL) -c -n :41315 || \
	    ($(call color,You probably need to install ekam and put it on your path; see github.com/sandstorm-io/ekam) && false)

# ====================================================================
# Front-end shell

shell-env: tmp/.shell-env

# Note that we need Ekam to build node_modules before we can run Meteor, hence
# the dependency on tmp/.ekam-run.
tmp/.shell-env: tmp/.ekam-run $(IMAGES) shell/imports/client/changelog.html shell/client/styles/_icons.scss shell/package.json shell/npm-shrinkwrap.json
	@$(call color,configuring meteor frontend)
	@mkdir -p tmp
	@mkdir -p node_modules/capnp
	@bash -O extglob -c 'cp src/capnp/!(*test*).capnp node_modules/capnp'
	@cd shell/ && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm install
	@touch tmp/.shell-env

# grunt-webfont 0.4.8 does not work on Node 12. The latest version of grunt-webfont, OTOH, produces
# a broken font file (all icons invisible and zero-width). For now we stick with the old version
# and run it using Meteor 1.8.2's node which is old enough to run it. This means you have to
# install Meteor 1.8.2 in addition to the latest version in order to build Sandstorm. :(
METEOR_DEV_BUNDLE_ICONS=$(shell ./find-meteor-dev-bundle.sh METEOR@1.8.2)

icons/node_modules: icons/package.json
	cd icons && PATH=$(METEOR_DEV_BUNDLE_ICONS)/bin:$$PATH $(METEOR_DEV_BUNDLE_ICONS)/bin/npm install

shell/client/styles/_icons.scss: icons/node_modules icons/*svg icons/Gruntfile.js
	cd icons && PATH=$(METEOR_DEV_BUNDLE_ICONS)/bin:$$PATH ./node_modules/.bin/grunt

shell/imports/client/changelog.html: CHANGELOG.md
	@mkdir -p tmp
	@echo '<template name="changelog">' > tmp/changelog.html
	@markdown CHANGELOG.md >> tmp/changelog.html
	@echo '</template>' >> tmp/changelog.html
	@cp tmp/changelog.html shell/imports/client/changelog.html

shell/public/close-FFFFFF.svg: icons/close.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#FFFFFF/g' < $< > $@

shell/public/install-714DAA.svg: icons/install.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#714DAA/g' < $< > $@

shell/public/install-896AC6.svg: icons/install.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#896AC6/g' < $< > $@

shell/public/plus-6A237C.svg: icons/plus.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#6A237C/g' < $< > $@

shell/public/plus-9E40B5.svg: icons/plus.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#9E40B5/g' < $< > $@

shell/public/upload-B7B7B7.svg: icons/upload.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#B7B7B7/g' < $< > $@

shell/public/upload-5D5D5D.svg: icons/upload.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#5D5D5D/g' < $< > $@

shell/public/restore-B7B7B7.svg: icons/restore.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#B7B7B7/g' < $< > $@

shell/public/restore-5D5D5D.svg: icons/restore.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#5D5D5D/g' < $< > $@

shell/public/%.svg: icons/%.svg
	@$(call color,color for dark background $<)
	@sed -e 's/#111111/#CCCCCC/g' < $< > $@

shell/public/google-color.svg: icons/google.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#a53232/g' < $< > $@
shell/public/github-color.svg: icons/github.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#191919/g' < $< > $@

shell/public/email-494949.svg: icons/email.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#494949/g' < $< > $@

shell/public/question-a9a9a9.svg: icons/question.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#A9A9A9/g' < $< > $@

shell/public/question-727272.svg: icons/question.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#727272/g' < $< > $@

shell/public/%-m.svg: icons/%.svg
	@$(call color,color for light background $<)
	@# Make completely black.
	@sed -e 's/#111111/#000000/g' < $< > $@

shell-build: shell/imports/* shell/imports/*/* shell/imports/*/*/* shell/imports/*/*/*/* shell/client/main.ts shell/server/main.ts shell/public/* shell/i18n/* shell/.meteor/packages shell/.meteor/release shell/.meteor/versions tmp/.shell-env
	@$(call color,building meteor frontend)
	@test -z "$$(find -L shell/* -type l)" || (echo "error: broken symlinks in shell: $$(find -L shell/* -type l)" >&2 && exit 1)
	@OLD=`pwd` && cd shell && meteor build --directory "$$OLD/shell-build"

# ====================================================================
# Bundle

bundle: tmp/.ekam-run shell-build make-bundle.sh localedata-C meteor-bundle-main.js
	@$(call color,bundle)
	@CC=$(CC) ./make-bundle.sh

sandstorm-$(BUILD).tar.xz: bundle
	@$(call color,compress release bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -9e > sandstorm-$(BUILD).tar.xz

sandstorm-$(BUILD)-fast.tar.xz: bundle
	@$(call color,compress fast bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -0 --threads=0 > sandstorm-$(BUILD)-fast.tar.xz

# ====================================================================
# app-index.spk

# This is currently really really hacky because spk is not good at using a package definition file
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

# ====================================================================
# test-app.spk

# This is currently really really hacky because spk is not good at using a package definition file
# that is not located at the root of the source tree. In particular it is hard for the package
# definition file (living in the src tree) to refer to the `test-app` binary (living in the
# tmp tree).
#
# TODO(cleanup): Make spk better so that it can handle this.

test-app.spk: tmp/.ekam-run
	@cp src/sandstorm/test-app/test-app.capnp tmp/sandstorm/test-app/test-app.capnp
	@cp src/sandstorm/test-app/*.html tmp/sandstorm/test-app
	bin/spk pack -ksrc/sandstorm/test-app/test-app.key -Isrc -Itmp -ptmp/sandstorm/test-app/test-app.capnp:pkgdef test-app.spk

test-app-dev: tmp/.ekam-run
	@cp src/sandstorm/test-app/test-app.capnp tmp/sandstorm/test-app/test-app.capnp
	@cp src/sandstorm/test-app/*.html tmp/sandstorm/test-app
	spk dev -Isrc -Itmp -ptmp/sandstorm/test-app/test-app.capnp:pkgdef

# ====================================================================
# meteor-testapp.spk

$(METEOR_SPK):
	@$(call color,downloading meteor-spk)
	@curl https://dl.sandstorm.io/meteor-spk-$(METEOR_SPK_VERSION).tar.xz | tar Jxf -

meteor-testapp-dev:
	cd meteor-testapp && PATH="$(PWD)/bin:$(PATH)" \
		$(METEOR_SPK) dev -I../src -I../tmp -s /opt/sandstorm

tests/assets/meteor-testapp.spk: \
		meteor-testapp \
		$(METEOR_SPK) \
		meteor-testapp/client/* \
		meteor-testapp/server/* \
		meteor-testapp/.meteor/*
	@cd meteor-testapp && PATH="$(PWD)/bin:$(PATH)" \
		$(METEOR_SPK) pack -kmeteor-testapp.key -I../src -I../tmp ../tests/assets/meteor-testapp.spk
