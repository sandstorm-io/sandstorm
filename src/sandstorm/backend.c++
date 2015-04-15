// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

#include "backend.h"
#include <kj/debug.h>
#include "util.h"

namespace sandstorm {

BackendImpl::BackendImpl(kj::LowLevelAsyncIoProvider& ioProvider, kj::Network& network)
    : ioProvider(ioProvider), network(network), tasks(*this) {}

void BackendImpl::taskFailed(kj::Exception&& exception) {
  KJ_LOG(ERROR, exception);
}

// =======================================================================================

kj::Promise<Supervisor::Client> BackendImpl::bootGrain(
    kj::StringPtr grainId, kj::StringPtr packageId,
    spk::Manifest::Command::Reader command, bool isNew, bool devMode, bool isRetry) {
  auto iter = supervisors.find(grainId);
  if (iter != supervisors.end()) {
    KJ_REQUIRE(!isNew, "new grain matched existing grainId");

    // Supervisor for this grain is already running. Join that.
    return iter->second.promise.addBranch()
        .then([=](Supervisor::Client&& client) mutable {
      // We should send a keepAlive() to make sure the supervisor is still up.
      auto promise = client.keepAliveRequest().send();
      return promise.then([KJ_MVCAP(client)](auto) mutable -> kj::Promise<Supervisor::Client> {
        // Success.
        return kj::mv(client);
      }, [=](kj::Exception&& exception) mutable -> kj::Promise<Supervisor::Client> {
        // Exception?
        if (exception.getType() == kj::Exception::Type::DISCONNECTED) {
          // Oops, disconnected. onDisconnect() should have already fired causing the RunningGrain
          // to unregister itself. Give it an extra turn using evalLater() just in case, then
          // re-run.
          KJ_ASSERT(!isRetry, "retry supervisor startup logic failed");
          return kj::evalLater([=]() mutable {
            return bootGrain(grainId, packageId, command, isNew, devMode, true);
          });
        } else {
          return kj::mv(exception);
        }
      });
    });
  }

  // Grain is not currently running, so let's start it.
  kj::Own<kj::AsyncInputStream> stdoutPipe;
  {
    kj::Vector<kj::String> argv;

    argv.add(kj::heapString("supervisor"));

    if (isNew) {
      argv.add(kj::heapString("-n"));
    }

    if (devMode) {
      argv.add(kj::heapString("--dev"));
    }

    for (auto env: command.getEnviron()) {
      argv.add(kj::str("-e", env.getKey(), "=", env.getValue()));
    }

    argv.add(kj::heapString(packageId));
    argv.add(kj::heapString(grainId));

    argv.add(kj::heapString("--"));

    if (command.hasDeprecatedExecutablePath()) {
      argv.add(kj::heapString(command.getDeprecatedExecutablePath()));
    }
    for (auto arg: command.getArgv()) {
      argv.add(kj::heapString(arg));
    }

    Subprocess::Options options(KJ_MAP(a, argv) -> const kj::StringPtr { return a; });
    options.executable = "/sandstorm";

    int pipefds[2];
    KJ_SYSCALL(pipe2(pipefds, O_CLOEXEC));
    kj::AutoCloseFd stdoutOut(pipefds[1]);
    stdoutPipe = ioProvider.wrapInputFd(pipefds[0],
        kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP |
        kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC);
    options.stdout = stdoutOut;
    Subprocess(kj::mv(options)).detach();
  }

  // Wait until supervisor prints something on stdout, indicating that it is ready.
  static byte dummy[256];
  auto promise = stdoutPipe->read(dummy, 1, sizeof(dummy));

  // Meanwhile parse the socket address.
  auto addressPromise =
      network.parseAddress(kj::str("unix:/var/sandstorm/grains/", grainId, "/socket"));

  // When both of those are done, connect to the address.
  auto finalPromise = promise
      .then([this,KJ_MVCAP(addressPromise)](size_t n) mutable {
    return kj::mv(addressPromise);
  }).then([](kj::Own<kj::NetworkAddress>&& address) {
    return address->connect();
  }).then([this,KJ_MVCAP(stdoutPipe),grainId = kj::heapString(grainId)]
          (kj::Own<kj::AsyncIoStream>&& connection) mutable {
    // Connected. Create the RunningGrain and fulfill promises.
    auto ignorePromise = ignoreAll(*stdoutPipe);
    tasks.add(ignorePromise.attach(kj::mv(stdoutPipe)));

    auto grain = kj::heap<RunningGrain>(*this, kj::mv(grainId), kj::mv(connection));
    auto client = grain->getSupervisor();
    tasks.add(grain->onDisconnect().attach(kj::mv(grain)));
    return client;
  }).fork();

  // Add the promise to our map.
  StartingGrain startingGrain = {
    kj::heapString(grainId),
    kj::mv(finalPromise)
  };
  kj::StringPtr grainIdPtr = startingGrain.grainId;
  auto result = startingGrain.promise.addBranch();
  KJ_ASSERT(supervisors.insert(std::make_pair(grainIdPtr, kj::mv(startingGrain))).second);

  return result;
}

kj::Promise<void> BackendImpl::ignoreAll(kj::AsyncInputStream& input) {
  static byte dummy[256];
  return input.read(dummy, sizeof(dummy)).then([&input]() { ignoreAll(input); });
}

BackendImpl::RunningGrain::RunningGrain(
    BackendImpl& backend, kj::String grainId, kj::Own<kj::AsyncIoStream> stream)
    : backend(backend), grainId(kj::mv(grainId)),
      stream(kj::mv(stream)), client(*this->stream) {
  KJ_DBG("RunningGrain()");
}

BackendImpl::RunningGrain::~RunningGrain() noexcept(false) {
  KJ_DBG("~RunningGrain()");
  backend.supervisors.erase(grainId);
}

kj::Promise<void> BackendImpl::startGrain(StartGrainContext context) {
  KJ_DBG("startGrain");
  auto params = context.getParams();
  return bootGrain(params.getGrainId(), params.getPackageId(), params.getCommand(),
                   params.getIsNew(), params.getDevMode(), false)
      .then([context](Supervisor::Client client) mutable {
    context.getResults().setGrain(kj::mv(client));
  });
}

kj::Promise<void> BackendImpl::getGrain(GetGrainContext context) {
  auto iter = supervisors.find(context.getParams().getGrainId());
  if (iter != supervisors.end()) {
    return iter->second.promise.addBranch()
        .then([context](Supervisor::Client client) mutable {
      context.getResults().setGrain(kj::mv(client));
    });
  }

  return KJ_EXCEPTION(DISCONNECTED, "grain is not running");
}

kj::Promise<void> BackendImpl::deleteGrain(DeleteGrainContext context) {
  auto grainId = context.getParams().getGrainId();
  auto iter = supervisors.find(grainId);
  kj::Promise<void> shutdownPromise = nullptr;
  if (iter != supervisors.end()) {
    shutdownPromise = iter->second.promise.addBranch()
        .then([context](Supervisor::Client client) mutable {
      return client.shutdownRequest().send().then([](auto) {});
    }).then([]() -> kj::Promise<void> {
      return KJ_EXCEPTION(FAILED, "expected shutdown() to throw disconnected exception");
    }, [](kj::Exception&& e) -> kj::Promise<void> {
      if (e.getType() == kj::Exception::Type::DISCONNECTED) {
        return kj::READY_NOW;
      } else {
        return kj::mv(e);
      }
    });
  } else {
    shutdownPromise = kj::READY_NOW;
  }

  return shutdownPromise.then([grainId]() {
    recursivelyDelete(kj::str("/var/sandstorm/grains/", grainId));
  });
}

// =======================================================================================

kj::Promise<void> BackendImpl::installPackage(InstallPackageContext context)  {
  return KJ_EXCEPTION(UNIMPLEMENTED);
}

} // namespace sandstorm

