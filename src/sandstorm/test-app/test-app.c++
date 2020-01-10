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

class WebSessionImpl final: public sandstorm::WebSession::Server {
public:
  WebSessionImpl(sandstorm::UserInfo::Reader userInfo,
                 sandstorm::SessionContext::Client context,
                 sandstorm::WebSession::Params::Reader params,
                 bool isPowerboxRequest = false)
      : isPowerboxRequest(isPowerboxRequest),
        sessionContext(kj::mv(context)) {}

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
    // HTTP GET request.

    auto path = context.getParams().getPath();

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
    } else {
      KJ_FAIL_REQUIRE("unknown post path", path);
    }
  }

private:
  bool isPowerboxRequest;

  sandstorm::SessionContext::Client sessionContext;
};

// =======================================================================================

class UiViewImpl final: public sandstorm::MainView<ObjectId>::Server {
public:
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
                                 params.getSessionParams().getAs<sandstorm::WebSession::Params>()));

    return kj::READY_NOW;
  }

  kj::Promise<void> newRequestSession(NewRequestSessionContext context) override {
    auto params = context.getParams();

    KJ_REQUIRE(params.getSessionType() == capnp::typeId<sandstorm::WebSession>(),
               "Unsupported session type.");

    context.getResults().setSession(
        kj::heap<WebSessionImpl>(params.getUserInfo(), params.getContext(),
                                 params.getSessionParams().getAs<sandstorm::WebSession::Params>(),
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
      case ObjectId::NEXT:
      default:
        KJ_UNIMPLEMENTED("Unsupported ObjectID type. This shouldn't happen!");
    }
    return kj::READY_NOW;
  }
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
    auto rpcSystem = capnp::makeRpcServer(network, kj::heap<UiViewImpl>());

    // The `CLIENT` side of a `capnp::TwoPartyVatNetwork` does not serve its bootstrap capability
    // until it has initiated a request for the bootstrap capability of the `SERVER` side.
    // Therefore, we need to restore the supervisor's `SandstormApi` capability, even if we are not
    // going to use it.
    {
      capnp::MallocMessageBuilder message;
      auto vatId = message.getRoot<capnp::rpc::twoparty::VatId>();
      vatId.setSide(capnp::rpc::twoparty::Side::SERVER);
      sandstorm::SandstormApi<>::Client api =
          rpcSystem.bootstrap(vatId).castAs<sandstorm::SandstormApi<>>();
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
