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

#ifndef SANDSTORM_SUPERVISOR_H_
#define SANDSTORM_SUPERVISOR_H_

#include "abstract-main.h"
#include "util.h"
#include <kj/vector.h>
#include <kj/async-io.h>
#include <capnp/capability.h>
#include <sandstorm/supervisor.capnp.h>
#include <kj/io.h>

namespace sandstorm {

class SupervisorMain: public AbstractMain {
  // Main class for the Sandstorm supervisor.  This program:
  // - Sets up a sandbox for a grain.
  // - Executes the grain in the sandbox.
  // - Implements the platform API for the grain.
  // - Exposes a network interface through which the rest of the platform can talk to the grain.
  //
  // The supervisor places itself into the same sandbox as the grain, except that the supervisor
  // gets network access whereas the grain does not (the grain can only communicate with the world
  // through the supervisor).

public:
  SupervisorMain(kj::ProcessContext& context);

  kj::MainFunc getMain() override;

  void setIsNew(bool isNew);
  void setMountProc(bool mountProc);
  kj::MainBuilder::Validity setAppName(kj::StringPtr name);
  kj::MainBuilder::Validity setGrainId(kj::StringPtr id);
  kj::MainBuilder::Validity setPkg(kj::StringPtr path);
  kj::MainBuilder::Validity setVar(kj::StringPtr path);
  kj::MainBuilder::Validity setUid(kj::StringPtr arg);
  kj::MainBuilder::Validity addEnv(kj::StringPtr arg);
  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg);
  // Flag handlers

  inline bool getIsNew() { return isNew; }
  inline void setKeepStdio(bool keep) { keepStdio = keep; }

  class SystemConnector {
  public:
    virtual kj::Promise<void> run(kj::AsyncIoContext& ioContext,
                                  Supervisor::Client mainCapability,
                                  kj::Own<CapRedirector> coreRedirector) const = 0;
    // Begin accepting RPCs from the system.

    virtual void checkIfAlreadyRunning() const = 0;
    // Check if this grain is already running and, if so, exit.
    //
    // This is a method of SystemConnector because the mechanism of this check depends on the way
    // we connect to the system -- e.g. by default we try to form a connection to an existing
    // supervisor to see if it's already running.

    virtual kj::Maybe<int> getSaveFd() const = 0;
    // If this returns non-null, the indicated file descriptor should NOT be closed along with
    // everything else because it belongs to the SystemConnector. This FD MUST be O_CLOEXEC.
  };

  void setSystemConnector(SystemConnector& connector) { systemConnector = &connector; }
  // Use this to override the way SupervisorMain connects to "the system", or rather how the
  // system connects to it. "The system" means the rest of Sandstorm, e.g. the Sandstorm front-end.

  kj::MainBuilder::Validity run();

private:
  kj::ProcessContext& context;

  kj::String appName;
  kj::String grainId;
  kj::String pkgPath;
  kj::String varPath;
  kj::Vector<kj::String> command;
  kj::Vector<kj::String> environment;
  const SystemConnector* systemConnector;
  bool isNew = false;
  bool mountProc = false;
  bool keepStdio = false;
  bool devmode = false;
  bool seccompDumpPfc = false;
  kj::Maybe<uid_t> sandboxUid;  // nullptr = use userns

  class SandstormApiImpl;
  class SupervisorImpl;

  void bind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags = 0);
  kj::String realPath(kj::StringPtr path);
  void setupSupervisor();
  void closeFds();
  void setResourceLimits();
  void checkPaths();
  void writeSetgroupsIfPresent(const char *contents);
  void writeUserNSMap(const char *type, kj::StringPtr contents);
  void unshareOuter();
  void makeCharDeviceNode(const char *name, const char* realName, int major, int minor);
  void setupFilesystem();
  void setupStdio();
  void setupSeccomp();
  void unshareNetwork();
  bool checkIfIpTablesLoaded();
  void maybeFinishMountingProc();
  void permanentlyDropSuperuser();
  void enterSandbox();
  [[noreturn]] void runChild(int apiFd, kj::AutoCloseFd startEventFd);

  [[noreturn]] void runSupervisor(int apiFd, kj::AutoCloseFd startEventFd);

  class DefaultSystemConnector: public SystemConnector {
  public:
    kj::Promise<void> run(kj::AsyncIoContext& ioContext, Supervisor::Client mainCapability,
                          kj::Own<CapRedirector> coreRedirector) const override;
    void checkIfAlreadyRunning() const override;
    kj::Maybe<int> getSaveFd() const override { return nullptr; }

  private:
    class Listener;
    class ErrorHandlerImpl;
    kj::Promise<void> acceptLoop(kj::ConnectionReceiver& serverPort,
                                 Supervisor::Client bootstrapInterface,
                                 kj::TaskSet& taskSet);
  };

  static constexpr DefaultSystemConnector DEFAULT_CONNECTOR_INSTANCE = DefaultSystemConnector();
};

}  // namespace sandstorm

#endif  // SANDSTORM_SUPERVISOR_H_
