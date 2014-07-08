// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "fuse.h"
#include <kj/main.h>
#include <kj/io.h>
#include <kj/async-unix.h>
#include <kj/debug.h>

namespace sandstorm {

class FuseTest {
  // A test program that mounts a FUSE filesystem that just mirrors some other directory.

public:
  FuseTest(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Fuse test, unknown version",
          "Mounts a fuse filesystem at <mount-point> which mirrors <source-dir>.")
        .addOptionWithArg({'o', "options"}, KJ_BIND_METHOD(*this, setOptions), "<options>",
                          "Set mount options.")
        .addOption({'c', "cache-forever"}, KJ_BIND_METHOD(*this, setCacheForever),
                   "Assume for caching purposes that the source directory never changes.")
        .expectArg("<mount-point>", KJ_BIND_METHOD(*this, setMountPoint))
        .expectArg("<soure-dir>", KJ_BIND_METHOD(*this, setBindTo))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

private:
  kj::ProcessContext& context;
  kj::StringPtr options;
  kj::StringPtr mountPoint;
  kj::StringPtr bindTo;
  FuseOptions bindOptions;

  kj::MainBuilder::Validity setOptions(kj::StringPtr arg) {
    options = arg;
    return true;
  }

  kj::MainBuilder::Validity setCacheForever() {
    bindOptions.cacheForever = true;
    return true;
  }

  kj::MainBuilder::Validity setMountPoint(kj::StringPtr arg) {
    mountPoint = arg;
    return true;
  }

  kj::MainBuilder::Validity setBindTo(kj::StringPtr arg) {
    bindTo = arg;
    return true;
  }

  kj::MainBuilder::Validity run() {
    // Call fusermount to get the FD.

    kj::UnixEventPort::captureSignal(SIGINT);
    kj::UnixEventPort::captureSignal(SIGQUIT);
    kj::UnixEventPort::captureSignal(SIGTERM);
    kj::UnixEventPort::captureSignal(SIGHUP);

    kj::UnixEventPort eventPort;
    kj::EventLoop loop(eventPort);
    kj::WaitScope waitScope(loop);

    auto onSignal = eventPort.onSignal(SIGINT)
        .exclusiveJoin(eventPort.onSignal(SIGQUIT))
        .exclusiveJoin(eventPort.onSignal(SIGTERM))
        .exclusiveJoin(eventPort.onSignal(SIGHUP))
        .then([this](siginfo_t&& sig) {
      context.warning(kj::str("Shutting down due to signal: ", strsignal(sig.si_signo)));
    });

    auto root = newLoopbackFuseNode(bindTo, 1 * kj::SECONDS);

    FuseMount mount(mountPoint, options);

    context.warning("FUSE mirror mounted. Ctrl+C to unmount.");

    bindFuse(eventPort, mount.getFd(), kj::mv(root), bindOptions)
        .then([&]() {
          context.warning("Shutting down due to unmount.");
          mount.dontUnmount();
        })
        .exclusiveJoin(kj::mv(onSignal))
        .wait(waitScope);

    return true;
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::FuseTest)
