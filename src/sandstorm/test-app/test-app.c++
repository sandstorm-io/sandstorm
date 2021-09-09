// Copyright (c) 2014 Sandstorm Development Group, Inc.
// Licensed under the MIT License:
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

#include <iostream>
#include <map>

#include <sys/time.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/io.h>
#include <kj/async-io.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/serialize.h>

#include <sandstorm/grain.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sandstorm/hack-session.capnp.h>
#include <sandstorm/test-app/test-app.capnp.h>

namespace sandstorm {
namespace testapp {
namespace {

typedef unsigned int uint;
typedef unsigned char byte;

class ScheduledJobCallbackImpl final: public PersistentCallback::Server {
public:

  // Create a one-shot job
  ScheduledJobCallbackImpl(kj::String refStr, bool shouldCancel)
    : refStr(kj::mv(refStr)), shouldCancel(shouldCancel) {}

  kj::Promise<void> save(SaveContext context) override {
    auto results = context.getResults();
    auto sb = results.initObjectId().initScheduledCallback();
    sb.setShouldCancel(shouldCancel);
    sb.setRefStr(refStr);
    results.initLabel().setDefaultText("some label");
    return kj::READY_NOW;
  }

  kj::Promise<void> run(RunContext context) override {
    std::cout << "Running job " << refStr.cStr() << std::endl;
    context.getResults().setCancelFutureRuns(shouldCancel);
    return kj::READY_NOW;
  }
private:
  kj::String refStr;
  bool shouldCancel;
};

// =======================================================================================

class TestPowerboxCapImpl final: public TestPowerboxCap::Server {
public:
  explicit TestPowerboxCapImpl(kj::String text): text(kj::mv(text)) {}

  kj::Promise<void> save(SaveContext context) override {
    auto results = context.getResults();
    results.initObjectId().setText(text);
    results.initLabel().setDefaultText("some label");
    return kj::READY_NOW;
  }

  kj::Promise<void> read(ReadContext context) override {
    context.getResults().setText(text);
    return kj::READY_NOW;
  }

private:
  kj::String text;
};

// =======================================================================================

void testSystemApi() {
  // Test that some syscalls & platform APIs work as expected. Print a success
  // message to the console so the test suite can verify this.

  std::cout << "Testing System APIs" << std::endl;

  auto result = kj::runCatchingExceptions([]() {
    // Test use of /dev/shm:
    const char *obj_name = "/some-shm-obj";
    int shm_fd;
    KJ_SYSCALL(shm_fd = shm_open(obj_name, O_RDWR|O_CREAT, 0700));
    KJ_DEFER(KJ_SYSCALL(shm_unlink(obj_name)));

    // Make sure the mapping actually works:
    int *mapped = (int *)mmap(
      nullptr, sizeof(int), PROT_READ|PROT_WRITE, MAP_SHARED, shm_fd, 0
    );
    KJ_ASSERT(mapped != MAP_FAILED, "mmap() failed");
    KJ_ASSERT(close(shm_fd) == 0, "Closing shm_fd failed");
    KJ_SYSCALL(munmap(mapped, sizeof(int)));
  });

  KJ_IF_MAYBE(exception, result) {
    auto msg = kj::str(*exception);
    std::cout << msg.cStr() << std::endl;
    throw(*exception);
  }

  std::cout << "testSystemApi() passed." << std::endl;
}

// =======================================================================================

class WebSessionImpl final: public sandstorm::WebSession::Server {
public:
  WebSessionImpl(sandstorm::UserInfo::Reader userInfo,
                 sandstorm::SessionContext::Client context,
                 sandstorm::WebSession::Params::Reader params,
                 kj::Promise<sandstorm::SandstormApi<>::Client>& api,
                 bool isPowerboxRequest = false)
      : isPowerboxRequest(isPowerboxRequest),
        sessionContext(kj::mv(context)),
        api(api) {}

  kj::Promise<void> get(GetContext context) override {
    // HTTP GET request.

    auto path = context.getParams().getPath();

    if (path == "") {
      auto response = context.getResults().initContent();
      response.setMimeType("text/html");
      response.initBody().setBytes(isPowerboxRequest ? *TEST_POWERBOX_HTML : *TEST_APP_HTML);
      return kj::READY_NOW;
    } else {
      auto error = context.getResults().initClientError();
      error.setStatusCode(sandstorm::WebSession::Response::ClientErrorCode::NOT_FOUND);
      return kj::READY_NOW;
    }
  }

  kj::Promise<void> post(PostContext context) override {
    // HTTP POST request.

    auto params = context.getParams();
    auto path = params.getPath();

    if (path == "fulfill") {
      // Fulfill powerbox request by creating a new capability with the input text.
      context.getResults().initNoContent();

      auto req = sessionContext.fulfillRequestRequest();
      req.setCap(kj::heap<TestPowerboxCapImpl>(
          kj::str(context.getParams().getContent().getContent().asChars())));
      req.setDescriptor(TEST_DESC);

      return req.send().ignoreResult();
    } else if (path == "accept") {
      // Accept capability from powerbox request. Call read() and return the text.
      auto req = sessionContext.claimRequestRequest();
      req.setRequestToken(
          kj::str(context.getParams().getContent().getContent().asChars()));
      return req.send().getCap().castAs<TestPowerboxCap>().readRequest().send()
          .then([context](auto response) mutable -> void {
        auto httpResponse = context.getResults().initContent();
        httpResponse.setMimeType("text/plain");
        httpResponse.getBody().setBytes(response.getText().asBytes());
      });
    } else if(path == "test-system-api") {
      testSystemApi();
      return kj::READY_NOW;
    } else if(path == "schedule") {
      context.getResults().initNoContent();
      // Put the extra headers in a map, so we can easily look for specific ones:
      auto headers = params.getContext().getAdditionalHeaders();
      auto len = headers.size();
      std::map<kj::StringPtr, kj::StringPtr> headerMap;
      for(size_t i = 0; i < len; i++) {
        auto elem = headers[i];
        headerMap[elem.getName()] = elem.getValue();
      }

      auto oneShot = headerMap["x-sandstorm-app-test-schedule-oneshot"] == "true";
      auto period = headerMap["x-sandstorm-app-test-schedule-period"];
      auto cancel = headerMap["x-sandstorm-app-test-schedule-should-cancel"] == "true";
      auto refStr = headerMap["x-sandstorm-app-test-schedule-refstr"];
      return api.then([oneShot, period, cancel, refStr](auto api) -> auto {
        auto req = api.scheduleRequest();
        req.initName().setDefaultText(refStr);
        req.setCallback(kj::heap(ScheduledJobCallbackImpl(kj::heapString(refStr), cancel)));
        auto sched = req.getSchedule();
        if(oneShot) {
          struct timeval tv;
          KJ_SYSCALL(gettimeofday(&tv, nullptr));
          // Add 30 seconds to make sure we don't specify something that's in the past by
          // the time sandstorm sees it:
          uint64_t when = tv.tv_sec + 30;
          when *= 1e9; // Convert to nanosecods.

          auto os = sched.initOneShot();
          os.setWhen(when);
          os.setSlack(MINIMUM_SCHEDULING_SLACK);
        } else if(period == "hourly") {
          sched.setPeriodic(SchedulingPeriod::HOURLY);
        } else {
          KJ_UNIMPLEMENTED("Only hourly jobs are supported by the test app");
        }
        return req.send();
      }).ignoreResult();
    } else {
      KJ_FAIL_REQUIRE("unknown post path", path);
    }
  }

private:
  bool isPowerboxRequest;
  sandstorm::SessionContext::Client sessionContext;
  kj::Promise<sandstorm::SandstormApi<>::Client>& api;
};

// =======================================================================================

class UiViewImpl final: public sandstorm::MainView<ObjectId>::Server {
public:

  UiViewImpl(kj::Promise<sandstorm::SandstormApi<>::Client> api)
  : api(kj::mv(api)) {}

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    auto viewInfo = context.initResults();

    auto descriptor = viewInfo.initMatchRequests(1)[0];
    auto tag = descriptor.initTags(1)[0];
    tag.setId(capnp::typeId<TestPowerboxCap>());
    tag.initValue().setAs<TestPowerboxCap::PowerboxTag>(TEST_TAG);

    return kj::READY_NOW;
  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();

    KJ_REQUIRE(params.getSessionType() == capnp::typeId<sandstorm::WebSession>(),
               "Unsupported session type.");

    context.getResults().setSession(
        kj::heap<WebSessionImpl>(params.getUserInfo(), params.getContext(),
                                 params.getSessionParams().getAs<sandstorm::WebSession::Params>(),
                                 api));

    return kj::READY_NOW;
  }

  kj::Promise<void> newRequestSession(NewRequestSessionContext context) override {
    auto params = context.getParams();

    KJ_REQUIRE(params.getSessionType() == capnp::typeId<sandstorm::WebSession>(),
               "Unsupported session type.");

    context.getResults().setSession(
        kj::heap<WebSessionImpl>(params.getUserInfo(), params.getContext(),
                                 params.getSessionParams().getAs<sandstorm::WebSession::Params>(),
                                 api,
                                 true));

    return kj::READY_NOW;
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto objId = context.getParams().getObjectId();
    switch(objId.which()) {
      case ObjectId::TEXT:
        context.getResults().setCap(kj::heap<TestPowerboxCapImpl>(
            kj::str(objId.getText())
        ));
        break;
      case ObjectId::SCHEDULED_CALLBACK:
        {
          auto sc = objId.getScheduledCallback();
          context.getResults().setCap(kj::heap<ScheduledJobCallbackImpl>(
            ScheduledJobCallbackImpl(
                kj::heapString(sc.getRefStr().cStr()),
                sc.getShouldCancel()
          )));
          break;
        }
      default:
        KJ_UNIMPLEMENTED("Unsupported ObjectID type. This shouldn't happen!");
    }
    return kj::READY_NOW;
  }
private:
  kj::Promise<sandstorm::SandstormApi<>::Client> api;
};

// =======================================================================================

class ServerMain {
public:
  ServerMain(kj::ProcessContext& context): context(context), ioContext(kj::setupAsyncIo()) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm Thin Server",
                           "Intended to be run as the root process of a Sandstorm app.")
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity run() {
    // Set up RPC on file descriptor 3.
    auto stream = ioContext.lowLevelProvider->wrapSocketFd(3);
    capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);

    auto pf = kj::newPromiseAndFulfiller<sandstorm::SandstormApi<>::Client>();
    auto rpcSystem = capnp::makeRpcServer(network, kj::heap<UiViewImpl>(kj::mv(pf.promise)));

    {
      capnp::MallocMessageBuilder message;
      auto vatId = message.getRoot<capnp::rpc::twoparty::VatId>();
      vatId.setSide(capnp::rpc::twoparty::Side::SERVER);
      sandstorm::SandstormApi<>::Client api =
          rpcSystem.bootstrap(vatId).castAs<sandstorm::SandstormApi<>>();
      pf.fulfiller->fulfill(kj::mv(api));
    }

    kj::NEVER_DONE.wait(ioContext.waitScope);
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext ioContext;
};

}  // anonymous namespace
}  // namespace testapp
}  // namespace sandstorm

KJ_MAIN(sandstorm::testapp::ServerMain)
