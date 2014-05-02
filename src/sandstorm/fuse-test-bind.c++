// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

#include "fuse.h"
#include <kj/main.h>
#include <kj/io.h>
#include <kj/async-unix.h>

namespace sandstorm {

class FuseTest {
  // A test program that mounts a FUSE filesystem that just mirrors some other directory.

public:
  FuseTest(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Fuse test, unknown version",
          "Mounts a fuse filesystem at <mount-point> which mirrors <source-dir>.")
        .expectArg("<mount-point>", KJ_BIND_METHOD(*this, setMountPoint))
        .expectArg("<soure-dir>", KJ_BIND_METHOD(*this, setBindTo))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

private:
  kj::ProcessContext& context;
  kj::StringPtr mountPoint;
  kj::StringPtr bindTo;

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

    FuseMount mount(mountPoint, "");

    bindFuse(eventPort, mount.getFd(), kj::mv(root))
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
