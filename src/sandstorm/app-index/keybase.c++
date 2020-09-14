#include "keybase.h"

#include <kj/encoding.h>
#include <kj/io.h>
#include <capnp/orphan.h>
#include <capnp/serialize-packed.h>
#include <capnp/compat/json.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/powerbox.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/app-index/keybase-api.capnp.h>
#include <sandstorm/app-index/app-index.capnp.h>
#include <sandstorm/util.h>

namespace sandstorm {
namespace appindex {
namespace keybase {

kj::String getPowerboxDescriptor() {
  capnp::MallocMessageBuilder msg;
  auto desc = msg.initRoot<PowerboxDescriptor>();
  auto tag = desc.initTags(1)[0];
  tag.setId(capnp::typeId<ApiSession>());
  auto tagValue = tag.initValue().getAs<ApiSession::PowerboxTag>();
  tagValue.setCanonicalUrl("https://keybase.io/_/api/1.0");

  kj::VectorOutputStream vec;
  capnp::writePackedMessage(vec, msg);
  return kj::encodeBase64(vec.getArray());
}

Endpoint::Endpoint(ApiSession::Client&& apiSession)
  : apiSession(kj::mv(apiSession)) {}

kj::Promise<kj::Maybe<kj::Own<capnp::MallocMessageBuilder>>> Endpoint::getFingerPrintIdentity(kj::StringPtr fingerprint) {
  return lookupFingerPrint(fingerprint).then([](auto results) {
    KJ_REQUIRE(results->getStatus().getCode() == 0);
    KJ_REQUIRE(results->getStatus().getName() == "OK");


    auto them = results->getThem();
    kj::Maybe<kj::Own<capnp::MallocMessageBuilder>> ret;
    if(them.size() == 0) {
      return kj::mv(ret);
    }
    auto result = them[0];

    auto msg = kj::heap<capnp::MallocMessageBuilder>();
    auto identity = msg->initRoot<KeybaseIdentity>();
    identity.setKeybaseHandle(result.getBasics().getUsername());
    identity.setName(result.getProfile().getFullName());
    identity.setPicture(result.getPictures().getPrimary().getUrl());

    kj::Vector<kj::StringPtr> websites;
    kj::Vector<kj::StringPtr> githubHandles;
    kj::Vector<kj::StringPtr> twitterHandles;
    kj::Vector<kj::StringPtr> hackernewsHandles;
    kj::Vector<kj::StringPtr> redditHandles;
    for(auto proof : result.getProofsSummary().getAll()) {
      auto nametag = proof.getNametag();
      auto type = proof.getProofType();
      if(type == "generic_web_site") {
        websites.add(nametag);
      } else if(type == "github") {
        githubHandles.add(nametag);
      } else if(type == "twitter") {
        twitterHandles.add(nametag);
      } else if(type == "hackernews") {
        hackernewsHandles.add(nametag);
      } else if(type == "reddit") {
        redditHandles.add(nametag);
      } else {
        KJ_LOG(WARNING, "Unknown keybase proof type: ", type, "; skipping.");
      }
    }
#define TO_STRPTR_ARRAY(array) KJ_MAP(s, array) -> capnp::Text::Reader { return s; }
    identity.setWebsites(TO_STRPTR_ARRAY(websites));
    identity.setGithubHandles(TO_STRPTR_ARRAY(githubHandles));
    identity.setTwitterHandles(TO_STRPTR_ARRAY(twitterHandles));
    identity.setHackernewsHandles(TO_STRPTR_ARRAY(hackernewsHandles));
    identity.setRedditHandles(TO_STRPTR_ARRAY(redditHandles));
#undef TO_STRPTR_ARRAY

    ret = kj::mv(msg);
    return kj::mv(ret);
  });
}

kj::Promise<kj::Own<LookupResults::Reader>> Endpoint::lookupFingerPrint(kj::StringPtr pgpFingerPrint) {
  auto req = apiSession.getRequest();
  req.setPath(kj::str(
    "user/lookup.json?key_fingerprint=",
    pgpFingerPrint,
    "&fields=pictures,profile,proofs_summary"));
  auto context = req.initContext();
  auto paf = kj::newPromiseAndFulfiller<ByteStream::Client>();
  context.setResponseStream(capnp::Capability::Client(kj::mv(paf.promise))
      .castAs<ByteStream>());
  return req.send().then([fulfiller = kj::mv(paf.fulfiller)](auto resp) {
      switch(resp.which()) {
        case WebSession::Response::CONTENT: {
          auto content = resp.getContent();
          auto body = content.getBody();
          switch(body.which()) {
            case WebSession::Response::Content::Body::BYTES: {
              auto bytes = body.getBytes();
              capnp::JsonCodec json;
              capnp::MallocMessageBuilder msg;
              auto results = msg.initRoot<LookupResults>();
              json.handleByAnnotation<LookupResults>();
              json.decode(bytesToString(bytes.asBytes()), results);
              return capnp::clone(results.asReader());
            }
            case WebSession::Response::Content::Body::STREAM:
              KJ_FAIL_ASSERT("TODO(now)");
              break;
          }
          break;
        }
        default:
          KJ_FAIL_REQUIRE("keybase http request failed.");
      }
  });
}

};
};
};
