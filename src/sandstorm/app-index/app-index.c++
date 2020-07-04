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

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/io.h>
#include <kj/async-io.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/serialize.h>
#include <capnp/serialize-packed.h>
#include <capnp/membrane.h>
#include <capnp/compat/json.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <ctype.h>
#include <sodium/crypto_sign.h>
#include <map>

#include <sandstorm/grain.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/hack-session.capnp.h>
#include <sandstorm/util.h>
#include <sandstorm/app-index/app-index.capnp.h>
#include <sandstorm/spk.h>
#include <sandstorm/id-to-text.h>

#include "indexer.h"

namespace sandstorm {
namespace appindex {

kj::String htmlEscape(kj::StringPtr text) {
  kj::Vector<char> result(text.size() + 1);
  for (char c: text) {
    switch (c) {
      case '<': result.addAll(kj::StringPtr("&lt;")); break;
      case '>': result.addAll(kj::StringPtr("&gt;")); break;
      case '&': result.addAll(kj::StringPtr("&amp;")); break;
      default: result.add(c); break;
    }
  }
  result.add('\0');
  return kj::String(result.releaseAsArray());
}

template <typename Context>
void handleError(Context& context, kj::Exception&& e) {
  KJ_LOG(ERROR, e);
  auto error = context.getResults().initServerError();
  error.setDescriptionHtml(kj::str("Error: ", htmlEscape(e.getDescription()), "\n"));
}

class SubmissionSession final: public ApiSession::Server {
public:
  explicit SubmissionSession(Indexer& indexer, HackSessionContext::Client session)
      : indexer(indexer), session(kj::mv(session)) {}

  kj::Promise<void> post(PostContext context) override {
    return kj::evalNow([&]() -> kj::Promise<void> {
      auto params = context.getParams();
      auto path = params.getPath();
      if (path == "upload") {
        auto content = params.getContent();
        KJ_REQUIRE(!content.hasEncoding(), "can't accept encoded (e.g. gzipped) upload");

        // Write content to upload stream: a write() followed by a done(), and a getResults().
        auto stream = indexer.newUploadStream();
        auto promises = kj::heapArrayBuilder<kj::Promise<void>>(3);
        auto req1 = stream.writeRequest();
        req1.setData(content.getContent());
        promises.add(req1.send());
        promises.add(stream.doneRequest().send().then([](auto&&) {}));
        promises.add(stream.getResultRequest().send().then([](auto&&) {}));

        context.releaseParams();

        // Return "no content" when getResult() completes.
        context.initResults().initNoContent();
        return kj::joinPromises(promises.finish());
      } else if (path == "status") {
        auto content = params.getContent();
        KJ_REQUIRE(!content.hasEncoding(), "POST can't be encoded (e.g. gzipped)");

        capnp::MallocMessageBuilder requestMessage;

        auto origBytes = content.getContent();
        kj::ArrayInputStream stream(origBytes);
        requestMessage.setRoot(capnp::PackedMessageReader(stream).getRoot<SubmissionRequest>());

        // Whatever is left in the input is the signature. What ever was consumed from the input is
        // the request.
        kj::ArrayPtr<const byte> signature = stream.tryGetReadBuffer();
        KJ_ASSERT(signature.begin() >= origBytes.begin() && signature.end() <= origBytes.end());
        kj::ArrayPtr<const byte> requestBytes = kj::arrayPtr(origBytes.begin(), signature.begin());

        auto req = requestMessage.getRoot<SubmissionRequest>();

        // TODO(security): Verify request's webkey hash. Need to know our own webkey, somehow.

        auto packageId = packageIdString(req.getPackageId());

        KJ_REQUIRE(signature.size() == crypto_sign_BYTES, "invalid signature");

        capnp::MallocMessageBuilder response;
        byte appPublicKey[crypto_sign_PUBLICKEYBYTES];
        if (indexer.tryGetPublicKey(packageId, appPublicKey)) {
          KJ_ASSERT(
              crypto_sign_verify_detached(signature.begin(),
                  requestBytes.begin(), requestBytes.size(), appPublicKey) == 0,
              "signature validation failed");

          bool changed = false;
          if (req.isSetState()) {
            auto mutation = req.getSetState();
            changed = indexer.setSubmissionState(
                packageId, mutation.getNewState(), mutation.getSequenceNumber());
          }

          indexer.getSubmissionStatus(packageId, response);

          if (changed) {
            // Force update now!
            indexer.updateIndex();
          }
        } else {
          response.getRoot<SubmissionStatus>().setNotUploaded();
        }

        auto status = response.getRoot<SubmissionStatus>();
        auto outBytes = kj::heapArray<byte>(
            status.totalSize().wordCount * sizeof(capnp::word) + 128);
        kj::ArrayOutputStream outStream(outBytes);
        {
          // We prefix with a NUL byte to indicate a binary response, because unfortunately the
          // client tool uses curl with which it is excessively difficult to distinguish error
          // responses from success. Ugh.
          auto buffer = outStream.getWriteBuffer();
          buffer[0] = 0;
          outStream.write(buffer.begin(), 1);
        }
        capnp::writePackedMessage(outStream, response);

        auto httpResponse = context.getResults().initContent();
        httpResponse.setMimeType("application/octet-stream");
        httpResponse.initBody().setBytes(outStream.getArray());

        if (!req.isSetState() ||
            !response.getRoot<SubmissionStatus>().isPending()) {
          return kj::READY_NOW;
        }

        // Send notification email to app index reviewers.
        auto appTitle = indexer.getAppTitle(packageId);
        auto notificationText = kj::str(
            "An app package is pending review in the app index.\n\n"
            "https://alpha.sandstorm.io/grain/NujwEZfut8oZoSdcrFzy9p/\n\n"
            "title: ", appTitle, "\n"
            "packageId: ", packageIdString(req.getPackageId()), "\n"
            "requested state: ", req.getSetState().getNewState(), "\n");

        return session.getPublicIdRequest().send()
            .then([this,KJ_MVCAP(appTitle),KJ_MVCAP(notificationText)](auto&& publicId) mutable {
          return session.getUserAddressRequest().send()
              .then([this,KJ_MVCAP(appTitle),KJ_MVCAP(notificationText),KJ_MVCAP(publicId)]
                    (auto&& response) mutable {
            auto emailReq = session.sendRequest();
            auto email = emailReq.initEmail();
            auto from = email.initFrom();
            from.setName("App Index");
            from.setAddress(kj::str(publicId.getPublicId(), "@", publicId.getHostname()));
            auto to = email.initTo(1)[0];
            to.setAddress("app-index@corp.sandstorm.io");
            to.setName("App Index Notifications");
            email.setSubject(kj::str("App index: ", appTitle));
            email.setText(notificationText);
            return emailReq.send().ignoreResult();
          });
        });
      } else {
        auto error = context.getResults().initClientError();
        error.setStatusCode(WebSession::Response::ClientErrorCode::NOT_FOUND);
        error.setDescriptionHtml("<html><body><pre>404 not found</pre></body></html>");
        return kj::READY_NOW;
      }
    }).catch_([context](kj::Exception&& e) mutable {
      handleError(context, kj::mv(e));
    });
  }

  kj::Promise<void> postStreaming(PostStreamingContext context) override {
    auto params = context.getParams();
    auto path = params.getPath();
    if (path == "upload") {
      KJ_REQUIRE(!params.hasEncoding(), "can't accept encoded (e.g. gzipped) upload");
      context.releaseParams();

      context.getResults(capnp::MessageSize {4,1}).setStream(
          capnp::membrane(indexer.newUploadStream(), kj::refcounted<RequestStreamMembrane>())
              .castAs<WebSession::RequestStream>());
      return kj::READY_NOW;
    } else {
      // This should cause the shell to retry using regular post().
      KJ_UNIMPLEMENTED("postStreaming() only implemented for /upload");
    }
  }

private:
  Indexer& indexer;
  HackSessionContext::Client session;

  class StreamWrapper final: public WebSession::RequestStream::Server {
  public:
    explicit StreamWrapper(AppIndex::UploadStream::Client inner): inner(kj::mv(inner)) {}

  protected:
    kj::Promise<void> getResponse(GetResponseContext context) override {
      return kj::evalNow([&]() -> kj::Promise<void> {
        context.releaseParams();
        return inner.getResultRequest().send().then([this,context](auto&&) mutable {
          context.initResults().initNoContent();
        });
      }).catch_([context](kj::Exception&& e) mutable {
        handleError(context, kj::mv(e));
      });
    }

  private:
    AppIndex::UploadStream::Client inner;
  };

  class RequestStreamMembrane final: public capnp::MembranePolicy, public kj::Refcounted {
    // Turns an AppIndex::UploadStream into a WebSession::RequestStream. Any ByteStream method
    // calls pass through, but other calls are redirected to a wrapper.
  public:
    kj::Maybe<capnp::Capability::Client> inboundCall(
        uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
      if (interfaceId != capnp::typeId<ByteStream>()) {
        return WebSession::RequestStream::Client(
            kj::heap<StreamWrapper>(target.castAs<AppIndex::UploadStream>()));
      }
      return nullptr;
    }

    kj::Maybe<capnp::Capability::Client> outboundCall(
        uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
      // Never called.
      return nullptr;
    }

    kj::Own<MembranePolicy> addRef() override { return kj::addRef(*this); }
  };
};

class ReviewSession final: public WebSession::Server {
public:
  ReviewSession(Indexer& indexer, HackSessionContext::Client session, bool canApprove)
      : indexer(indexer), session(kj::mv(session)), canApprove(canApprove) {}

  kj::Promise<void> get(GetContext context) override {
    return kj::evalNow([&]() -> kj::Promise<void> {
      auto path = context.getParams().getPath();
      if (path == "") {
        auto content = context.getResults().initContent();
        content.setMimeType("text/html; charset=utf-8");
        content.initBody().setBytes(REVIEW_APP_HTML->asBytes());
      } else if (path == "queue") {
        auto content = context.getResults().initContent();
        content.setMimeType("application/json");
        content.initBody().setBytes(indexer.getReviewQueueJson().asBytes());
      } else if (path == "public-id") {
        context.releaseParams();
        return session.getPublicIdRequest().send().then([context](auto&& result) mutable {
          auto content = context.getResults().initContent();
          content.setMimeType("application/json");
          content.initBody().setBytes(capnp::JsonCodec().encode(result).asBytes());
        });
      } else {
        auto error = context.getResults().initClientError();
        error.setStatusCode(WebSession::Response::ClientErrorCode::NOT_FOUND);
        error.setDescriptionHtml("<html><body><pre>404 not found</pre></body></html>");
      }

      return kj::READY_NOW;
    }).catch_([context](kj::Exception&& e) mutable {
      handleError(context, kj::mv(e));
    });
  }

  kj::Promise<void> post(PostContext context) override {
    return kj::evalNow([&]() -> kj::Promise<void> {
      KJ_REQUIRE(canApprove, "approval permission denied; you can only view the review queue");

      auto params = context.getParams();
      auto path = params.getPath();
      KJ_LOG(INFO, path);
      if (path.startsWith("approve/")) {
        // TODO(soon): Set URL.
        indexer.approve(path.slice(strlen("approve/")), "");
        indexer.updateIndex();
        context.getResults().initNoContent();
      } else if (path.startsWith("reject/")) {
        indexer.reject(path.slice(strlen("reject/")),
            kj::str(params.getContent().getContent().asChars()));
        indexer.updateIndex();  // remove from experimental
        context.getResults().initNoContent();
      } else if (path.startsWith("unapprove/")) {
        indexer.unapprove(path.slice(strlen("unapprove/")));
        indexer.updateIndex();
        context.getResults().initNoContent();
      } else if (path == "reindex") {
        indexer.updateIndex();
        context.getResults().initNoContent();
      } else if (path.startsWith("keybase/")) {
        // As a temporary hack, we process keybase API results client-side and then upload them
        // in a non-JSON format.
        //
        // TODO(cleanup): Implement a JSON parser that we can run server-side.

        auto fingerprint = path.slice(strlen("keybase/"));
        KJ_REQUIRE(fingerprint.size() >= 32 && fingerprint.size() <= 128, "bad fingerprint");
        for (char c: fingerprint) {
          KJ_REQUIRE(isalnum(c), "bad fingerprint");
        }

        kj::Vector<kj::String> keys;
        std::map<kj::StringPtr, kj::Vector<kj::String>> items;
        auto lines = splitLines(kj::heapString(params.getContent().getContent().asChars()));

        for (auto& line: lines) {
          size_t colonPos = KJ_REQUIRE_NONNULL(line.findFirst(':'));
          auto key = kj::heapString(line.slice(0, colonPos));
          items[key].add(kj::heapString(line.slice(colonPos + 1)));
          keys.add(kj::mv(key));
        }

        capnp::MallocMessageBuilder message;
        auto keybase = message.getRoot<KeybaseIdentity>();

        KJ_REQUIRE(items["username"].size() > 0, "missing username");
        keybase.setKeybaseHandle(items["username"][0]);

        if (items["name"].size() > 0) {
          keybase.setName(items["name"][0]);
        }
        if (items["picture"].size() > 0 && items["picture"][0].startsWith("http")) {
          keybase.setPicture(items["picture"][0]);
        }

#define TO_STRPTR_ARRAY(array) KJ_MAP(s, array) -> capnp::Text::Reader { return s; }
        keybase.setWebsites(TO_STRPTR_ARRAY(items["proof.generic_web_site"]));
        keybase.setGithubHandles(TO_STRPTR_ARRAY(items["proof.github"]));
        keybase.setTwitterHandles(TO_STRPTR_ARRAY(items["proof.twitter"]));
        keybase.setHackernewsHandles(TO_STRPTR_ARRAY(items["proof.hackernews"]));
        keybase.setRedditHandles(TO_STRPTR_ARRAY(items["proof.reddit"]));
#undef TO_STRPTR_ARRAY

        indexer.addKeybaseProfile(fingerprint, message);
        context.getResults().initNoContent();
      } else {
        auto error = context.getResults().initClientError();
        error.setStatusCode(WebSession::Response::ClientErrorCode::NOT_FOUND);
        error.setDescriptionHtml("<html><body><pre>404 not found</pre></body></html>");
      }

      return kj::READY_NOW;
    }).catch_([context](kj::Exception&& e) mutable {
      handleError(context, kj::mv(e));
    });
  }

private:
  Indexer& indexer;
  HackSessionContext::Client session;
  bool canApprove;  // True if the user has approver permission.
};

class UiViewImpl final: public UiView::Server {
public:
  explicit UiViewImpl(Indexer& indexer): indexer(indexer) {}

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    context.setResults(APP_INDEX_VIEW_INFO);
    return kj::READY_NOW;
  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();

    auto userInfo = params.getUserInfo();
    auto permissions = userInfo.getPermissions();
    auto hasPermission = [&](uint index) {
      return index < permissions.size() && permissions[index];
    };

    UiSession::Client result = nullptr;

    if (params.getSessionType() == capnp::typeId<ApiSession>()) {
      KJ_REQUIRE(hasPermission(SUBMIT_PERMISSION),
                 "client does not have permission to submit apps; can't use API");
      result = kj::heap<SubmissionSession>(
          indexer, params.getContext().castAs<HackSessionContext>());
    } else if (params.getSessionType() == capnp::typeId<WebSession>()) {
      KJ_REQUIRE(hasPermission(REVIEW_PERMISSION),
                 "client does not have permission to review apps; can't use web interface");
      result = kj::heap<ReviewSession>(
          indexer, params.getContext().castAs<HackSessionContext>(),
          hasPermission(APPROVE_PERMISSION));
    } else {
      KJ_FAIL_REQUIRE("Unsupported session type.");
    }

    context.initResults(capnp::MessageSize {4, 1}).setSession(kj::mv(result));
    return kj::READY_NOW;
  }

private:
  Indexer& indexer;
};

class AppIndexMain {
public:
  AppIndexMain(kj::ProcessContext& context): context(context), ioContext(kj::setupAsyncIo()) {
    kj::_::Debug::setLogLevel(kj::LogSeverity::INFO);
  }

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm App Index",
                           "Runs the Sandstorm app index.")
        .addOption({'i', "init"}, KJ_BIND_METHOD(*this, init), "first run")
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity init() {
    KJ_SYSCALL(mkdir("/var/packages", 0777));
    KJ_SYSCALL(mkdir("/var/apps", 0777));
    KJ_SYSCALL(mkdir("/var/keybase", 0777));
    KJ_SYSCALL(mkdir("/var/www", 0777));
    KJ_SYSCALL(mkdir("/var/www/apps", 0777));
    KJ_SYSCALL(mkdir("/var/www/experimental", 0777));
    KJ_SYSCALL(mkdir("/var/www/images", 0777));
    KJ_SYSCALL(mkdir("/var/www/packages", 0777));
    KJ_SYSCALL(mkdir("/var/tmp", 0777));
    return true;
  }

  kj::MainBuilder::Validity run() {
    mkdir("/var/www/experimental", 0777);  // back-compat; ignore already exists error
    mkdir("/var/apps", 0777);  // back-compat; ignore already exists error

    Indexer indexer;

    // Set up RPC on file descriptor 3.
    auto stream = ioContext.lowLevelProvider->wrapSocketFd(3);
    capnp::TwoPartyClient client(*stream, kj::heap<UiViewImpl>(indexer));

    // TODO(soon):  We don't use this, but for some reason the connection doesn't come up if we
    //   don't do this bootstrap.  Cap'n Proto bug?  v8capnp bug?  Shell bug?
    client.bootstrap();

    kj::NEVER_DONE.wait(ioContext.waitScope);
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext ioContext;
};

} // namespace appindex
} // namespace sandstorm

KJ_MAIN(sandstorm::appindex::AppIndexMain)
