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
#include "spk.h"
#include <capnp/serialize.h>
#include <capnp/serialize-async.h>
#include <stdio.h>  // rename()

namespace sandstorm {

static kj::StringPtr validateId(kj::StringPtr id) {
  KJ_REQUIRE(id.size() >= 8 && !id.startsWith(".") && id.findFirst('/') == nullptr, id);
  return id;
}

static void tryRecursivelyDelete(kj::StringPtr path) {
  KJ_REQUIRE(!path.endsWith("/"),
      "refusing to recursively delete directory name with trailing / to reduce risk of "
      "catastrophic empty-string bugs");
  static uint counter = 0;
  auto tmpPath = kj::str("/var/sandstorm/tmp/deleting.", time(nullptr), ".", counter++);

  while (rename(path.cStr(), tmpPath.cStr()) < 0) {
    int error = errno;
    if (error == ENOENT) {
      return;
    } else if (error != EINTR) {
      KJ_FAIL_SYSCALL("rename(path, tmpPath)", error, path, tmpPath);
    }
  }

  recursivelyDelete(tmpPath);
}

BackendImpl::BackendImpl(kj::LowLevelAsyncIoProvider& ioProvider, kj::Network& network,
  SandstormCoreFactory::Client&& sandstormCoreFactory,
  Cgroup&& cgroup,
  kj::Maybe<uid_t> sandboxUid)
    : ioProvider(ioProvider), network(network), coreFactory(kj::mv(sandstormCoreFactory)),
      sandboxUid(sandboxUid),
      tasks(*this),
      cgroup(kj::mv(cgroup))
    {}

void BackendImpl::taskFailed(kj::Exception&& exception) {
  KJ_LOG(ERROR, exception);
}

// =======================================================================================

kj::Promise<Supervisor::Client> BackendImpl::bootGrain(
    kj::StringPtr grainId, kj::StringPtr packageId,
    spk::Manifest::Command::Reader command, bool isNew, bool devMode, bool mountProc,
    bool isRetry) {
  auto iter = supervisors.find(grainId);
  if (iter != supervisors.end()) {
    KJ_REQUIRE(!isNew, "new grain matched existing grainId");

    // Supervisor for this grain is already running. Join that.
    return iter->second.promise.addBranch()
        .then([=](Supervisor::Client&& client) mutable {
      // We should send a keepAlive() to make sure the supervisor is still up. We should also
      // send a new SandstormCore capability in case the front-end has restarted.
      auto coreReq = coreFactory.getSandstormCoreRequest();
      coreReq.setGrainId(grainId);
      auto keepAliveReq = client.keepAliveRequest();
      keepAliveReq.setCore(coreReq.send().getCore());
      auto promise = keepAliveReq.send();
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
            return bootGrain(grainId, packageId, command, isNew, devMode, mountProc, true);
          });
        } else {
          return kj::mv(exception);
        }
      });
    });
  }

  // Grain is not currently running, so let's start it.
  kj::Own<kj::AsyncInputStream> stdoutPipe;
  kj::Vector<kj::String> argv;

  argv.add(kj::heapString("supervisor"));

  KJ_IF_MAYBE(u, sandboxUid) {
    argv.add(kj::heapString("--uid"));
    argv.add(kj::str(*u));
  }

  if (isNew) {
    argv.add(kj::heapString("-n"));
  }

  if (devMode) {
    argv.add(kj::heapString("--dev"));

    if (mountProc) {
      argv.add(kj::heapString("--proc"));
    }
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

  if (sandboxUid != nullptr) {
    // Supervisor must run as root since user namespaces are not available.
    options.uid = uid_t(0);
  }

  int pipefds[2];
  KJ_SYSCALL(pipe2(pipefds, O_CLOEXEC));
  kj::AutoCloseFd stdoutOut(pipefds[1]);
  stdoutPipe = ioProvider.wrapInputFd(pipefds[0],
      kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP |
      kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC);
  options.stdout = stdoutOut;
  Subprocess process(kj::mv(options));

  // Wait until supervisor prints something on stdout, indicating that it is ready.
  static byte dummy[256];
  auto promise = stdoutPipe->read(dummy, 1, sizeof(dummy));

  // Meanwhile parse the socket address.
  auto addressPromise =
      network.parseAddress(kj::str("unix:/var/sandstorm/grains/", grainId, "/socket"));

  // When both of those are done, connect to the address, and move the
  // supervisor into a cgroup.
  auto finalPromise = promise
      .then([KJ_MVCAP(addressPromise)](size_t n) mutable {
    return kj::mv(addressPromise);
  }).then([](kj::Own<kj::NetworkAddress>&& address) {
    return address->connect();
  }).then([this,KJ_MVCAP(stdoutPipe),KJ_MVCAP(process),grainId = kj::heapString(grainId)]
          (kj::Own<kj::AsyncIoStream>&& connection) mutable {

    cgroup
      .getOrMakeChild(grainId)
      .addPid(process.getPid());

    // Connected. Create the RunningGrain and fulfill promises.
    auto ignorePromise = ignoreAll(*stdoutPipe);
    tasks.add(ignorePromise.attach(kj::mv(stdoutPipe)));

    auto coreRequest = coreFactory.getSandstormCoreRequest();
    coreRequest.setGrainId(grainId);
    auto core = coreRequest.send().getCore();
    auto grain = kj::heap<RunningGrain>(*this, kj::mv(grainId), kj::mv(connection), kj::mv(core));
    auto client = grain->getSupervisor();
    tasks.add(grain->onDisconnect().attach(kj::mv(grain), kj::mv(process)));
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
  return input.tryRead(dummy, sizeof(dummy), sizeof(dummy))
      .then([&input](size_t n) -> kj::Promise<void> {
    if (n < sizeof(dummy)) {
      return kj::READY_NOW;
    } else {
      return ignoreAll(input);
    }
  });
}

kj::Promise<kj::String> BackendImpl::readAll(kj::AsyncInputStream& input, kj::Vector<char> soFar) {
  soFar.resize(soFar.size() + 4096);
  return input.tryRead(soFar.end() - 4096, 4096, 4096)
      .then([KJ_MVCAP(soFar),&input](size_t n) mutable -> kj::Promise<kj::String> {
    if (n < 4096) {
      // Must be EOF.
      soFar.resize(soFar.size() - 4096 + n);
      soFar.add('\0');
      return kj::String(soFar.releaseAsArray());
    } else {
      return readAll(input, kj::mv(soFar));
    }
  });
}

BackendImpl::RunningGrain::RunningGrain(
    BackendImpl& backend, kj::String grainId, kj::Own<kj::AsyncIoStream> stream,
    SandstormCore::Client&& core)
    : backend(backend), grainId(kj::mv(grainId)),
      stream(kj::mv(stream)), client(*this->stream, kj::mv(core)) {}

BackendImpl::RunningGrain::~RunningGrain() noexcept(false) {
  backend.supervisors.erase(grainId);
  backend.cgroup.removeChild(grainId);
}

kj::Promise<void> BackendImpl::ping(PingContext context) {
  return kj::READY_NOW;
}

kj::Promise<void> BackendImpl::startGrain(StartGrainContext context) {
  auto params = context.getParams();
  return bootGrain(validateId(params.getGrainId()),
                   validateId(params.getPackageId()), params.getCommand(),
                   params.getIsNew(), params.getDevMode(), params.getMountProc(), false)
      .then([context](Supervisor::Client client) mutable {
    context.getResults().setSupervisor(kj::mv(client));
  });
}

kj::Promise<void> BackendImpl::getGrain(GetGrainContext context) {
  auto grainId = context.getParams().getGrainId();
  auto iter = supervisors.find(validateId(grainId));
  if (iter != supervisors.end()) {
    return iter->second.promise.addBranch()
        .then([this,context,grainId](Supervisor::Client client) mutable {
      // We should send a keepAlive() to make sure the supervisor is still up. We should also
      // send a new SandstormCore capability in case the front-end has restarted.
      auto coreReq = coreFactory.getSandstormCoreRequest();
      coreReq.setGrainId(grainId);
      auto keepAliveReq = client.keepAliveRequest();
      keepAliveReq.setCore(coreReq.send().getCore());
      return keepAliveReq.send()
          .then([context,KJ_MVCAP(client)](auto&&) mutable -> kj::Promise<void> {
        context.getResults().setSupervisor(kj::mv(client));
        return kj::READY_NOW;
      }, [](kj::Exception&& e) -> kj::Promise<void> {
        if (e.getType() != kj::Exception::Type::DISCONNECTED) {
          KJ_LOG(ERROR, "Exception when trying to keepAlive() a supervisor in getGrain().", e);
          return KJ_EXCEPTION(DISCONNECTED, "grain is not running");
        } else {
          return kj::mv(e);
        }
      });
    });
  }

  return KJ_EXCEPTION(DISCONNECTED, "grain is not running");
}

kj::Promise<void> BackendImpl::deleteGrain(DeleteGrainContext context) {
  auto grainId = validateId(context.getParams().getGrainId());
  auto iter = supervisors.find(grainId);
  kj::Promise<void> shutdownPromise = nullptr;
  if (iter != supervisors.end()) {
    shutdownPromise = iter->second.promise.addBranch()
        .then([](Supervisor::Client client) mutable {
      return client.shutdownRequest().send().ignoreResult();
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
    tryRecursivelyDelete(kj::str("/var/sandstorm/grains/", grainId));
  });
}

kj::Promise<void> BackendImpl::transferGrain(TransferGrainContext context) {
  // Nothing to do: Grains aren't stored by owner.
  return kj::READY_NOW;
}

kj::Promise<void> BackendImpl::deleteUser(DeleteUserContext context) {
  // Nothing to do: We store no per-user data in the back-end.
  return kj::READY_NOW;
}

// =======================================================================================

class BackendImpl::PackageUploadStreamImpl final: public Backend::PackageUploadStream::Server {
public:
  PackageUploadStreamImpl(BackendImpl& backend, Pipe inPipe = Pipe::make(),
                          Pipe outPipe = Pipe::make())
      : sandboxUid(backend.sandboxUid),
        inputWriteFd(kj::mv(inPipe.writeEnd)),
        outputReadFd(kj::mv(outPipe.readEnd)),
        inputWriteEnd(backend.ioProvider.wrapOutputFd(inputWriteFd,
            kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC)),
        outputReadEnd(backend.ioProvider.wrapInputFd(outputReadFd,
            kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC)),
        tmpdir(tempDirname()),
        unpackProcess(startProcess(kj::mv(inPipe.readEnd), kj::mv(outPipe.writeEnd), tmpdir,
                                   backend.sandboxUid)) {}
  ~PackageUploadStreamImpl() noexcept(false) {
    if (access(tmpdir.cStr(), F_OK) >= 0) {
      KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() {
        recursivelyDelete(tmpdir);
      })) {
        // Somehow, this sometimes throws with ENOENT, but I don't understand why. We really don't
        // want to throw out of this destructor, though, because it seems to cause state confusion
        // in the RPC layer.
        KJ_LOG(ERROR, *e);
      }
    }
  }

protected:
  kj::Promise<void> write(WriteContext context) override {
    auto forked = writeQueue.then([this,context]() mutable {
      auto data = context.getParams().getData();
      return KJ_REQUIRE_NONNULL(inputWriteEnd, "called write() after done()")
          ->write(data.begin(), data.size());
    }).fork();

    writeQueue = forked.addBranch();
    return forked.addBranch();
  }

  kj::Promise<void> done(DoneContext context) override {
    auto forked = writeQueue.then([this]() mutable {
      KJ_REQUIRE(inputWriteEnd != nullptr, "called done() multiple times");
      inputWriteEnd = nullptr;
      inputWriteFd = nullptr;
    }).fork();

    writeQueue = forked.addBranch();
    return forked.addBranch();
  }

  kj::Promise<void> expectSize(ExpectSizeContext context) override {
    // don't care
    return kj::READY_NOW;
  }

  kj::Promise<void> saveAs(SaveAsContext context) override {
    KJ_REQUIRE(!saveCalled, "saveAs() already called");
    saveCalled = true;
    return readAll(*outputReadEnd).then([this,context](kj::String text) mutable {
      unpackProcess.waitForSuccess();

      auto packageId = validateId(context.getParams().getPackageId());
      auto finalName = kj::str("/var/sandstorm/apps/", packageId);
      bool exists = access(finalName.cStr(), F_OK) >= 0;
      if (!exists) {
        // Write app ID file.
        kj::FdOutputStream(
            raiiOpen(kj::str(finalName, ".appid"), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC))
            .write(text.begin(), text.size());

        // Move directory into place.
        KJ_SYSCALL(rename(tmpdir.cStr(), finalName.cStr()));
      }
      KJ_ON_SCOPE_FAILURE(if (!exists) { tryRecursivelyDelete(finalName); });

      capnp::ReaderOptions manifestLimits;
      manifestLimits.traversalLimitInWords = spk::Manifest::SIZE_LIMIT_IN_WORDS;
      capnp::StreamFdMessageReader reader(raiiOpen(
          kj::str(finalName, "/sandstorm-manifest"), O_RDONLY), manifestLimits);
      auto manifest = reader.getRoot<spk::Manifest>();

      capnp::MessageSize sizeHint = manifest.totalSize();
      sizeHint.wordCount += 8 + text.size() / sizeof(capnp::word);
      auto results = context.getResults(sizeHint);
      results.setAppId(trim(text));
      results.setManifest(manifest);
      KJ_IF_MAYBE(fp, checkPgpSignature(results.getAppId(), manifest.getMetadata(), sandboxUid)) {
        results.setAuthorPgpKeyFingerprint(*fp);
      }
    }, [this](kj::Exception&& e) {
      kj::runCatchingExceptions([&]() { recursivelyDelete(tmpdir); });
      kj::throwRecoverableException(kj::mv(e));
    });
  }

private:
  kj::Maybe<uid_t> sandboxUid;
  kj::AutoCloseFd inputWriteFd;
  kj::AutoCloseFd outputReadFd;
  kj::Maybe<kj::Own<kj::AsyncOutputStream>> inputWriteEnd;
  kj::Own<kj::AsyncInputStream> outputReadEnd;
  kj::Promise<void> writeQueue = kj::READY_NOW;
  kj::String tmpdir;
  Subprocess unpackProcess;
  bool saveCalled = false;

  static kj::String tempDirname() {
    static uint counter = 0;
    return kj::str("/var/sandstorm/tmp/unpacking.", time(nullptr), ".", counter++);
  }

  static Subprocess startProcess(
      kj::AutoCloseFd input, kj::AutoCloseFd output, kj::StringPtr outdir,
      kj::Maybe<uid_t> sandboxUid) {
    Subprocess::Options options({"spk", "unpack", "-", outdir});
    options.uid = sandboxUid;
    options.executable = "/proc/self/exe";
    options.stdin = input;
    options.stdout = output;
    return Subprocess(kj::mv(options));
  }
};

kj::Promise<void> BackendImpl::installPackage(InstallPackageContext context)  {
  context.getResults().setStream(kj::heap<PackageUploadStreamImpl>(*this));
  return kj::READY_NOW;
}

kj::Promise<void> BackendImpl::tryGetPackage(TryGetPackageContext context) {
  auto path = kj::str("/var/sandstorm/apps/", validateId(context.getParams().getPackageId()));

  KJ_IF_MAYBE(file, raiiOpenIfExists(kj::str(path, "/sandstorm-manifest"), O_RDONLY)) {
    capnp::ReaderOptions manifestLimits;
    manifestLimits.traversalLimitInWords = spk::Manifest::SIZE_LIMIT_IN_WORDS;
    capnp::StreamFdMessageReader reader(kj::mv(*file), manifestLimits);
    auto manifest = reader.getRoot<spk::Manifest>();

    kj::String appid = sandstorm::readAll(kj::str(path, ".appid"));

    capnp::MessageSize sizeHint = manifest.totalSize();
    sizeHint.wordCount += 8 + appid.size() / sizeof(capnp::word);
    auto results = context.getResults(sizeHint);
    results.setAppId(trim(appid));
    results.setManifest(manifest);
    KJ_IF_MAYBE(fp, checkPgpSignature(results.getAppId(), manifest.getMetadata(), sandboxUid)) {
      results.setAuthorPgpKeyFingerprint(*fp);
    }
  }

  return kj::READY_NOW;
}

kj::Promise<void> BackendImpl::deletePackage(DeletePackageContext context) {
  auto path = kj::str("/var/sandstorm/apps/", validateId(context.getParams().getPackageId()));
  if (access(path.cStr(), F_OK) >= 0) {
    tryRecursivelyDelete(path);
  }
  return kj::READY_NOW;
}

// =======================================================================================

kj::Promise<void> BackendImpl::backupGrain(BackupGrainContext context) {
  auto params = context.getParams();

  auto path = kj::str("/var/sandstorm/backups/", params.getBackupId());
  recursivelyCreateParent(path);
  auto grainDir = kj::str("/var/sandstorm/grains/", params.getGrainId());

  // Similar to the supervisor, the "backup" command sets up its own sandbox, and for that to work
  // we need to pass along root privileges to it.
  kj::Vector<kj::StringPtr> argv;
  kj::String ownUid;
  argv.add("backup");
  KJ_IF_MAYBE(u, sandboxUid) {
    argv.add("--uid");
    ownUid = kj::str(*u);
    argv.add(ownUid);
  }
  argv.add(path);
  argv.add(grainDir);

  Subprocess::Options processOptions(argv.asPtr());
  if (sandboxUid != nullptr) processOptions.uid = uid_t(0);
  processOptions.executable = "/proc/self/exe";
  auto inPipe = Pipe::make();
  processOptions.stdin = inPipe.readEnd;
  Subprocess process(kj::mv(processOptions));
  inPipe.readEnd = nullptr;

  auto metadata = params.getInfo();
  auto metadataMsg = kj::heap<capnp::MallocMessageBuilder>(metadata.totalSize().wordCount + 4);
  metadataMsg->setRoot(metadata);
  context.releaseParams();
  auto metadataStreamFd = kj::mv(inPipe.writeEnd);
  auto output = ioProvider.wrapOutputFd(
      metadataStreamFd, kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC);
  auto promise = capnp::writeMessage(*output, *metadataMsg);

  return promise.attach(kj::mv(metadataMsg), kj::mv(metadataStreamFd), kj::mv(output))
      .then([KJ_MVCAP(process)]() mutable {
    // TODO(cleanup): We should probably use a SubprocessSet to wait asynchronously, but that
    //   means we need to use SubprocessSet everywhere...
    process.waitForSuccess();
  });
}

kj::Promise<void> BackendImpl::restoreGrain(RestoreGrainContext context) {
  auto params = context.getParams();

  auto path = kj::str("/var/sandstorm/backups/", params.getBackupId());
  auto grainDir = kj::str("/var/sandstorm/grains/", params.getGrainId());

  // Similar to the supervisor, the "backup" command sets up its own sandbox, and for that to work
  // we need to pass along root privileges to it.
  kj::Vector<kj::StringPtr> argv;
  kj::String ownUid;
  argv.add("backup");
  KJ_IF_MAYBE(u, sandboxUid) {
    argv.add("--uid");
    ownUid = kj::str(*u);
    argv.add(ownUid);
  }
  argv.add("-r");
  argv.add(path);
  argv.add(grainDir);

  KJ_SYSCALL(mkdir(grainDir.cStr(), 0777));
  Subprocess::Options processOptions(argv.asPtr());
  if (sandboxUid != nullptr) processOptions.uid = uid_t(0);
  processOptions.executable = "/proc/self/exe";
  auto outPipe = Pipe::make();
  processOptions.stdout = outPipe.writeEnd;
  Subprocess process(kj::mv(processOptions));
  outPipe.writeEnd = nullptr;

  context.releaseParams();

  auto input = kj::mv(outPipe.readEnd);
  auto asyncInput = ioProvider.wrapInputFd(input, kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC);

  auto promise = capnp::readMessage(*asyncInput);
  return promise.attach(kj::mv(input), kj::mv(asyncInput), kj::mv(process))
      .then([context](kj::Own<capnp::MessageReader>&& message) mutable {
    auto metadata = message->getRoot<GrainInfo>();
    context.getResults(capnp::MessageSize { metadata.totalSize().wordCount + 4, 0 })
        .setInfo(metadata);
  });
}

class BackendImpl::FileUploadStream final: public ByteStream::Server {
public:
  FileUploadStream(kj::String finalPath)
      : tmpPath(kj::str(finalPath, ".uploading")),
        finalPath(kj::mv(finalPath)),
        fd(raiiOpen(tmpPath, O_WRONLY | O_CREAT | O_EXCL)) {}

  ~FileUploadStream() noexcept(false) {
    if (!isDone) {
      // Delete file that was never used. (Ignore errors here.)
      unlink(tmpPath.cStr());
    }
  }

protected:
  kj::Promise<void> write(WriteContext context) override {
    auto data = context.getParams().getData();
    kj::FdOutputStream(fd.get()).write(data.begin(), data.size());
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    KJ_SYSCALL(fsync(fd));
    KJ_SYSCALL(rename(tmpPath.cStr(), finalPath.cStr()));
    isDone = true;
    return kj::READY_NOW;
  }

  kj::Promise<void> expectSize(ExpectSizeContext context) override {
    // don't care
    return kj::READY_NOW;
  }

private:
  kj::String tmpPath;
  kj::String finalPath;
  kj::AutoCloseFd fd;
  bool isDone = false;

  static kj::String dirname(kj::StringPtr path) {
    KJ_IF_MAYBE(pos, path.findLast('/')) {
      return kj::heapString(path.slice(0, *pos));
    } else {
      return kj::heapString(".");
    }
  }
};

kj::Promise<void> BackendImpl::uploadBackup(UploadBackupContext context) {
  auto path = kj::str("/var/sandstorm/backups/", context.getParams().getBackupId());
  context.releaseParams();

  recursivelyCreateParent(path);

  context.getResults(capnp::MessageSize { 4, 1 }).setStream(
      kj::heap<FileUploadStream>(kj::mv(path)));
  return kj::READY_NOW;
}

kj::Promise<void> BackendImpl::downloadBackup(DownloadBackupContext context) {
  auto params = context.getParams();
  auto path = kj::str("/var/sandstorm/backups/", params.getBackupId());
  auto stream = params.getStream();
  context.releaseParams();

  auto fd = raiiOpen(path, O_RDONLY | O_CLOEXEC);
  struct stat stats;
  KJ_SYSCALL(fstat(fd, &stats));
  auto expectReq = stream.expectSizeRequest();
  expectReq.setSize(stats.st_size);
  auto expectPromise = expectReq.send();

  auto file = kj::heap<kj::FdInputStream>(kj::mv(fd));

  auto promise = pump(*file, kj::mv(stream));
  return promise.attach(kj::mv(file), kj::mv(expectPromise));
}

kj::Promise<void> BackendImpl::deleteBackup(DeleteBackupContext context) {
  auto path = kj::str("/var/sandstorm/backups/", context.getParams().getBackupId());
  while (unlink(path.cStr()) < 0) {
    int error = errno;
    if (error == ENOENT) {
      break;
    } else if (error != EINTR) {
      KJ_FAIL_SYSCALL("unlink", error, path);
    }
  }
  return kj::READY_NOW;
}

// =======================================================================================

static uint64_t recursivelyCountSize(kj::StringPtr path) {
  KJ_REQUIRE(!path.endsWith("/"),
      "refusing to recursively traverse directory name with trailing / to reduce risk of "
      "catastrophic empty-string bugs");

  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats));

  // Count blocks, not length, because what we care about is allocated space.
  uint64_t total = stats.st_blocks * 512;

  if (S_ISDIR(stats.st_mode)) {
    for (auto& file: listDirectory(path)) {
      total += recursivelyCountSize(kj::str(path, '/', file));
    }
  } else if (stats.st_nlink != 0) {
    // Don't overcount hard links. (Note that st_nlink can in fact be zero in cases where we are
    // racing with directory modifications, so we check for that to avoid divide-by-zero crashes.)
    total /= stats.st_nlink;
  }

  return total;
}

kj::Promise<void> BackendImpl::getGrainStorageUsage(GetGrainStorageUsageContext context) {
  context.getResults(capnp::MessageSize { 4, 0 }).setSize(recursivelyCountSize(
      kj::str("/var/sandstorm/grains/", validateId(context.getParams().getGrainId()))));
  return kj::READY_NOW;
}

} // namespace sandstorm

