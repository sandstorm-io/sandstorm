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

#include "indexer.h"
#include <sandstorm/app-index/app-index.capnp.h>
#include <sandstorm/spk.h>
#include <sandstorm/id-to-text.h>
#include <sandstorm/appid-replacements.h>
#include <capnp/serialize.h>
#include <stdlib.h>
#include <map>
#include <sodium/crypto_generichash_blake2b.h>
#include <sodium/crypto_sign.h>
#include <time.h>
#include <capnp/schema.h>
#include <capnp/compat/json.h>
#include <stdio.h>  // rename()

namespace sandstorm {
namespace appindex {

class StagingFile {
  // A file being written which will be atomically swapped into place once ready.
  //
  // TODO(cleanup): Make this a general library.

public:
  explicit StagingFile(kj::StringPtr targetDir)
      : name(kj::str(targetDir, "/.tmp.XXXXXX")) {
    int fd_;
    KJ_SYSCALL(fd_ = mkstemp(name.begin()));
    fd = kj::AutoCloseFd(fd_);
  }
  KJ_DISALLOW_COPY(StagingFile);

  ~StagingFile() noexcept(false) {
    if (!finalized) {
      KJ_SYSCALL(unlink(name.cStr())) { break; }
    }
  }

  void finalize(kj::StringPtr path) {
    KJ_REQUIRE(!finalized, "can't call finalize() twice");
    KJ_SYSCALL(fsync(fd));
    KJ_SYSCALL(rename(name.cStr(), path.cStr()));
    finalized = true;
  }

  int getFd() { return fd; }

private:
  kj::String name;
  kj::AutoCloseFd fd;
  bool finalized = false;
};

// =======================================================================================

void Indexer::addKeybaseProfile(kj::StringPtr fingerprint, capnp::MallocMessageBuilder& message) {
  StagingFile file("/var/keybase");
  capnp::writeMessageToFd(file.getFd(), message);
  file.finalize(kj::str("/var/keybase/", fingerprint));
}

bool Indexer::tryGetPublicKey(kj::StringPtr packageId, byte publicKey[crypto_sign_PUBLICKEYBYTES]) {
  KJ_REQUIRE(packageId.size() == 32, "invalid package ID", packageId);
  for (auto c: packageId) {
    KJ_REQUIRE(isalnum(c), "invalid package ID", packageId);
  }

  auto packageDir = kj::str("/var/packages/", packageId);
  auto spkFile = kj::str(packageDir, "/spk");

  while (access(spkFile.cStr(), F_OK) < 0) {
    int error = errno;
    if (error == ENOENT) {
      return false;
    } else if (error != EINTR) {
      KJ_FAIL_SYSCALL("access(spkFile, F_OK)", error, spkFile);
    }
  }

  auto infoFile = kj::str(packageDir, "/metadata");
  capnp::StreamFdMessageReader infoMessage(raiiOpen(infoFile, O_RDONLY));

  auto bytes = capnp::AnyStruct::Reader(
      infoMessage.getRoot<spk::VerifiedInfo>().getAppId()).getDataSection();
  KJ_ASSERT(bytes.size() == crypto_sign_PUBLICKEYBYTES);
  static_assert(crypto_sign_PUBLICKEYBYTES == APP_ID_BYTE_SIZE, "app ID size changed?");
  memcpy(publicKey, sandstorm::getPublicKeyForApp(bytes).begin(), crypto_sign_PUBLICKEYBYTES);

  return true;
}

template <typename Func>
static bool updatePackageStatus(kj::StringPtr packageId, Func&& func) {
  KJ_REQUIRE(packageId.size() == 32, "invalid package ID", packageId);
  for (auto c: packageId) {
    KJ_REQUIRE(isalnum(c), "invalid package ID", packageId);
  }

  auto packageDir = kj::str("/var/packages/", packageId);
  auto spkFile = kj::str(packageDir, "/spk");
  KJ_SYSCALL(access(spkFile.cStr(), F_OK),
             "no such package; try uploading it again");

  auto statusFile = kj::str(packageDir, "/status");
  capnp::MallocMessageBuilder statusMessage;
  capnp::readMessageCopyFromFd(raiiOpen(statusFile, O_RDONLY), statusMessage);
  auto status = statusMessage.getRoot<SubmissionStatus>();
  if (!func(status)) return false;
  if (status.getPublishDate() == 0 &&
      status.getRequestState() == SubmissionState::PUBLISH &&
      status.isApproved()) {
    status.setPublishDate(time(nullptr));
  }

  StagingFile newStatus(packageDir);
  capnp::writeMessageToFd(newStatus.getFd(), statusMessage);
  newStatus.finalize(statusFile);
  return true;
}

void Indexer::approve(kj::StringPtr packageId, kj::StringPtr url) {
  updatePackageStatus(packageId, [&](auto&& status) {
    if (status.isApproved()) return false;
    status.setApproved(url);
    return true;
  });
}

void Indexer::unapprove(kj::StringPtr packageId) {
  updatePackageStatus(packageId, [](auto&& status) {
    if (status.isPending()) return false;
    status.setPending();
    return true;
  });
}

void Indexer::reject(kj::StringPtr packageId, kj::StringPtr reason) {
  updatePackageStatus(packageId, [&](auto&& status) {
    status.setNeedsUpdate(reason);
    return true;
  });
}

bool Indexer::setSubmissionState(kj::StringPtr packageId, SubmissionState state,
                                 uint64_t sequence) {
  return updatePackageStatus(packageId, [&](auto&& status) {
    if (status.getRequestState() == state) return false;
    KJ_REQUIRE(sequence >= status.getNextSequenceNumber(),
               "bad sequence number in request; replay attack?");
    status.setRequestState(state);
    status.setNextSequenceNumber(sequence + 1);
    return true;
  });
}

void Indexer::getSubmissionStatus(kj::StringPtr packageId, capnp::MessageBuilder& output) {
  KJ_REQUIRE(packageId.size() == 32, "invalid package ID", packageId);
  for (auto c: packageId) {
    KJ_REQUIRE(isalnum(c), "invalid package ID", packageId);
  }

  auto packageDir = kj::str("/var/packages/", packageId);
  auto spkFile = kj::str(packageDir, "/spk");
  KJ_SYSCALL(access(spkFile.cStr(), F_OK),
             "no such package; try uploading it again");

  auto statusFile = kj::str(packageDir, "/status");
  capnp::readMessageCopyFromFd(raiiOpen(statusFile, O_RDONLY), output);
}

kj::String Indexer::getAppTitle(kj::StringPtr packageId) {
  capnp::StreamFdMessageReader message(
      sandstorm::raiiOpen(kj::str("/var/packages/", packageId, "/metadata"), O_RDONLY));
  return kj::str(message.getRoot<spk::VerifiedInfo>().getTitle().getDefaultText());
}

// =======================================================================================

namespace {

class DataHandler: public capnp::JsonCodec::Handler<capnp::Data> {
public:
  void encode(const capnp::JsonCodec& codec, capnp::Data::Reader input,
              capnp::JsonValue::Builder output) const override {
    output.setString(base64Encode(input, false));
  }

  capnp::Orphan<capnp::Data> decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
      capnp::Orphanage orphanage) const override {
    KJ_UNIMPLEMENTED("DataHandler::decode");
  }
};

}  // namespace

void Indexer::updateIndexInternal(kj::StringPtr outputDir, bool experimental) {
  capnp::MallocMessageBuilder scratch;
  auto orphanage = scratch.getOrphanage();

  struct AppEntry {
    kj::String appId;
    uint version = 0;
    capnp::Orphan<AppIndexForMarket::App> summary;
    capnp::Orphan<AppDetailsForMarket> details;
  };
  std::map<kj::StringPtr, AppEntry> appMap;

  for (auto& packageId: listDirectory("/var/packages")) {
    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      auto spkFile = kj::str("/var/packages/", packageId, "/spk");
      auto metadataFile = kj::str("/var/packages/", packageId, "/metadata");
      auto statusFile = kj::str("/var/packages/", packageId, "/status");

      KJ_SYSCALL(access(spkFile.cStr(), F_OK));

      capnp::StreamFdMessageReader statusMessage(raiiOpen(statusFile, O_RDONLY));
      auto status = statusMessage.getRoot<SubmissionStatus>();
      auto include = experimental ? status.isPending() : status.isApproved();
      if (include && status.getRequestState() == SubmissionState::PUBLISH) {
        capnp::StreamFdMessageReader metadataMessage(raiiOpen(metadataFile, O_RDONLY));
        auto info = metadataMessage.getRoot<spk::VerifiedInfo>();
        auto metadata = info.getMetadata();

        // Hard-link spk. Note that we intentionally continue to publish outdated SPKs unless
        // the author un-publishes them.
        auto spkLinkName = kj::str("/var/www/packages/", packageId);
        while (link(spkFile.cStr(), spkLinkName.cStr()) < 0) {
          int error = errno;
          if (error == EEXIST) {
            // Already linked.
            break;
          } else if (error != EINTR) {
            KJ_FAIL_SYSCALL("link(spkFile, spkLinkName)", error, spkFile, spkLinkName);
          }
        }

        // Update entry.
        auto appId = appIdString(info.getAppId());
        auto iter = appMap.find(appId);
        if (iter == appMap.end() || info.getVersion() >= iter->second.version) {
          auto summaryOrphan = orphanage.newOrphan<AppIndexForMarket::App>();
          auto summary = summaryOrphan.get();
          auto detailsOrphan = orphanage.newOrphan<AppDetailsForMarket>();
          auto details = detailsOrphan.get();

          summary.setAppId(info.getAppId());
          summary.setName(info.getTitle().getDefaultText());
          summary.setVersion(info.getMarketingVersion().getDefaultText());
          summary.setVersionNumber(info.getVersion());
          summary.setPackageId(info.getPackageId());

          auto icons = metadata.getIcons();

          if (icons.hasMarket() || icons.hasAppGrid()) {
            summary.setImageId(writeIcon(
                icons.hasMarket() ? icons.getMarket() : icons.getAppGrid()));
          }

          if (metadata.hasWebsite()) summary.setWebLink(metadata.getWebsite());
          if (metadata.hasCodeUrl()) summary.setCodeLink(metadata.getCodeUrl());

          summary.setIsOpenSource(metadata.getLicense().isOpenSource());
          summary.setCategories(KJ_MAP(c, metadata.getCategories()) { return categoryName(c); });

          if (info.hasAuthorPgpKeyFingerprint()) {
            KJ_IF_MAYBE(fd, raiiOpenIfExists(
                kj::str("/var/keybase/", info.getAuthorPgpKeyFingerprint()), O_RDONLY)) {
              capnp::StreamFdMessageReader reader(fd->get());
              auto keybase = reader.getRoot<KeybaseIdentity>();
              auto author = summary.initAuthor();
              author.setName(keybase.getName());
              author.setKeybaseUsername(keybase.getKeybaseHandle());
              if (keybase.hasPicture()) author.setPicture(keybase.getPicture());

              auto github = keybase.getGithubHandles();
              if (github.size() > 0) author.setGithubUsername(github[0]);
              auto twitter = keybase.getTwitterHandles();
              if (twitter.size() > 0) author.setTwitterUsername(twitter[0]);
              auto hackernews = keybase.getHackernewsHandles();
              if (hackernews.size() > 0) author.setHackernewsUsername(hackernews[0]);
              auto reddit = keybase.getRedditHandles();
              if (reddit.size() > 0) author.setRedditUsername(reddit[0]);
            }
          }

          auto author = metadata.getAuthor();
          if (author.hasUpstreamAuthor()) {
            summary.setUpstreamAuthor(author.getUpstreamAuthor());
          }

          // TODO(soon): Additional HTML sanitization? Client should be doing that already...
          summary.setShortDescription(metadata.getShortDescription().getDefaultText());
          details.setDescription(metadata.getDescription().getDefaultText());

          auto screenshots = metadata.getScreenshots();
          auto screenshotsOut = details.initScreenshots(screenshots.size());
          for (auto i: kj::indices(screenshots)) {
            auto screenshot = screenshots[i];
            auto screenshotOut = screenshotsOut[i];
            screenshotOut.setImageId(writeScreenshot(screenshot));
            screenshotOut.setWidth(screenshot.getWidth());
            screenshotOut.setHeight(screenshot.getHeight());
          }

          auto license = metadata.getLicense();
          switch (license.which()) {
            case spk::Metadata::License::NONE:
              break;
            case spk::Metadata::License::OPEN_SOURCE: {
              auto osiLicenses = capnp::Schema::from<spk::OpenSourceLicense>().getEnumerants();
              auto licenseId = static_cast<uint>(license.getOpenSource());
              if (licenseId < osiLicenses.size()) {
                for (auto annotation: osiLicenses[licenseId].getProto().getAnnotations()) {
                  if (annotation.getId() == 0x9476412d0315d869ull) {
                    details.setLicense(
                        annotation.getValue().getStruct().getAs<spk::OsiLicenseInfo>().getTitle());
                    break;
                  }
                }
              }
              break;
            }
            case spk::Metadata::License::PROPRIETARY:
              details.setLicense("Proprietary");
              break;
            case spk::Metadata::License::PUBLIC_DOMAIN:
              details.setLicense("Public Domain");
              break;
          }

          time_t publishTime = status.getPublishDate();
          char timeStr[32];
          KJ_ASSERT(strftime(timeStr, sizeof(timeStr), "%FT%TZ", gmtime(&publishTime)) > 0);
          summary.setCreatedAt(timeStr);

          kj::String appIdCopy = kj::str(appId);
          auto& slot = appMap[appIdCopy];
          if (slot.appId == nullptr) slot.appId = kj::mv(appIdCopy);
          slot.version = info.getVersion();
          slot.summary = kj::mv(summaryOrphan);
          slot.details = kj::mv(detailsOrphan);
        }
      }
    })) {
      KJ_LOG(ERROR, "error processing package", packageId, *exception);
    }
  }

  KJ_IF_MAYBE(descriptionsFd, raiiOpenIfExists("/var/descriptions", O_RDONLY)) {
    capnp::StreamFdMessageReader reader(kj::mv(*descriptionsFd));
    for (auto override: reader.getRoot<ShortDescriptionOverrides>().getItems()) {
      auto iter = appMap.find(override.getAppId());
      if (iter != appMap.end()) {
        iter->second.summary.get().setShortDescription(override.getShortDescription());
      }
    }
  }

  AppIdJsonHandler appIdHandler;
  PackageIdJsonHandler packageIdHandler;
  capnp::JsonCodec json;
  json.addTypeHandler(appIdHandler);
  json.addTypeHandler(packageIdHandler);

  capnp::MallocMessageBuilder indexMessage;
  auto indexData = indexMessage.initRoot<AppIndexForMarket>();
  auto apps = indexData.initApps(appMap.size());
  uint i = 0;
  for (auto& appEntry: appMap) {
    apps.setWithCaveats(i++, appEntry.second.summary.getReader());

    auto text = json.encode(appEntry.second.details.getReader());
    StagingFile file(outputDir);
    kj::FdOutputStream(file.getFd()).write(text.begin(), text.size());
    file.finalize(kj::str(outputDir, "/", appEntry.first, ".json"));

    if (!experimental) {
      // Write the symlink under /var/apps.
      auto target = kj::str("../packages/",
          packageIdString(appEntry.second.summary.getReader().getPackageId()));
      auto linkPath = kj::str("/var/apps/", appEntry.first);
      auto tmpLinkPath = kj::str(linkPath, ".tmp");
      unlink(tmpLinkPath.cStr());  // just in case
      KJ_SYSCALL(symlink(target.cStr(), tmpLinkPath.cStr()));
      KJ_SYSCALL(rename(tmpLinkPath.cStr(), linkPath.cStr()));
    }
  }
  KJ_ASSERT(i == apps.size());

  auto text = json.encode(indexData);
  StagingFile file(outputDir);
  kj::FdOutputStream(file.getFd()).write(text.begin(), text.size());
  file.finalize(kj::str(outputDir, "/index.json"));
}

void Indexer::updateIndex() {
  updateIndexInternal("/var/www/apps", false);
  updateIndexInternal("/var/www/experimental", true);
}

kj::String Indexer::writeIcon(spk::Metadata::Icon::Reader icon) {
  switch (icon.which()) {
    case spk::Metadata::Icon::SVG:
      return writeImage(icon.getSvg().asBytes(), ".svg");

    case spk::Metadata::Icon::PNG: {
      auto png = icon.getPng();
      return writeImage(png.hasDpi2x() ? png.getDpi2x() : png.getDpi1x(), ".png");
    }

    case spk::Metadata::Icon::UNKNOWN:
      break;
  }

  KJ_FAIL_ASSERT("unknown icon type", (uint)icon.which());
}

kj::String Indexer::writeScreenshot(spk::Metadata::Screenshot::Reader screenshot) {
  switch (screenshot.which()) {
    case spk::Metadata::Screenshot::PNG:
      return writeImage(screenshot.getPng(), ".png");

    case spk::Metadata::Screenshot::JPEG:
      return writeImage(screenshot.getJpeg().asBytes(), ".jpeg");

    case spk::Metadata::Screenshot::UNKNOWN:
      break;
  }

  KJ_FAIL_ASSERT("unknown screenshot type", (uint)screenshot.which());
}

kj::String Indexer::writeImage(kj::ArrayPtr<const byte> data, kj::StringPtr extension) {
  // Hash the data to determine the filename.
  byte hash[16];
  crypto_generichash_blake2b(hash, sizeof(hash), data.begin(), data.size(), nullptr, 0);

  // Write if not already present.
  auto basename = kj::str(hexEncode(hash), extension);
  auto filename = kj::str("/var/www/images/", basename);

  if (access(filename.cStr(), F_OK) < 0) {
    StagingFile file("/var/www/images");
    kj::FdOutputStream(file.getFd()).write(data.begin(), data.size());
    file.finalize(filename);
  }

  return basename;
}

capnp::Text::Reader Indexer::categoryName(spk::Category category) {
  auto categories = capnp::Schema::from<spk::Category>().getEnumerants();
  auto categoryId = static_cast<uint>(category);
  if (categoryId < categories.size()) {
    for (auto annotation: categories[categoryId].getProto().getAnnotations()) {
      if (annotation.getId() == 0x8d51dd236606d205) {
        return annotation.getValue().getStruct().getAs<spk::CategoryInfo>().getTitle();
      }
    }
  }
  return "Other";
}

// =======================================================================================

kj::String Indexer::getReviewQueueJson() {
  kj::Vector<kj::String> reviewIds;

  for (auto& packageId: listDirectory("/var/packages")) {
    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      auto spkFile = kj::str("/var/packages/", packageId, "/spk");
      auto statusFile = kj::str("/var/packages/", packageId, "/status");

      KJ_SYSCALL(access(spkFile.cStr(), F_OK));

      capnp::StreamFdMessageReader statusMessage(raiiOpen(statusFile, O_RDONLY));
      auto status = statusMessage.getRoot<SubmissionStatus>();
      if (status.isPending() && status.getRequestState() != SubmissionState::IGNORE) {
        reviewIds.add(kj::str(packageId));
      }
    })) {
      KJ_LOG(ERROR, "error processing package", packageId, *exception);
    }
  }

  capnp::MallocMessageBuilder scratch;
  auto orphan = scratch.getOrphanage().newOrphan<capnp::List<spk::VerifiedInfo>>(reviewIds.size());
  auto list = orphan.get();
  uint i = 0;

  for (auto& packageId: reviewIds) {
    auto metadataFile = kj::str("/var/packages/", packageId, "/metadata");
    capnp::StreamFdMessageReader metadataMessage(raiiOpen(metadataFile, O_RDONLY));
    list.setWithCaveats(i++, metadataMessage.getRoot<spk::VerifiedInfo>());
  }

  AppIdJsonHandler appIdHandler;
  PackageIdJsonHandler packageIdHandler;
  DataHandler dataHandler;
  capnp::JsonCodec json;
  json.addTypeHandler(appIdHandler);
  json.addTypeHandler(packageIdHandler);
  json.addTypeHandler(dataHandler);
  json.setPrettyPrint(true);

  return json.encode(list);
}

// =======================================================================================

class Indexer::UploadStreamImpl: public AppIndex::UploadStream::Server {
public:
  UploadStreamImpl()
      : spkFile("/var/tmp") {}

protected:
  kj::Promise<void> write(WriteContext context) override {
    KJ_REQUIRE(!doneCalled, "called write() after done()");
    auto data = context.getParams().getData();
    kj::FdOutputStream(spkFile.getFd()).write(data.begin(), data.size());
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    KJ_REQUIRE(!doneCalled, "can only call done() once");
    doneCalled = true;
    doneCalledPaf.fulfiller->fulfill();
    return kj::READY_NOW;
  }

  kj::Promise<void> getResult(GetResultContext context) override {
    KJ_REQUIRE(!getResultCalled, "can only call getResult() once");
    getResultCalled = true;
    return doneCalledPaf.promise.then([this]() {
      capnp::MallocMessageBuilder infoMessage;
      auto info = infoMessage.getRoot<spk::VerifiedInfo>();
      KJ_SYSCALL(lseek(spkFile.getFd(), 0, SEEK_SET));
      verifySpk(spkFile.getFd(), openTemporary("/var/tmp"), info);
      auto metadata = info.getMetadata();
      auto author = metadata.getAuthor();
      KJ_ASSERT(author.hasContactEmail(),
          "package metadata is missing contact email; we need an email address to which to send "
          "notifications regarding the app listing");
      KJ_ASSERT(metadata.getCategories().size() > 0,
          "package metadata does not list any categories (genres); you must list at least one!");
      auto shortDescription = metadata.getShortDescription().getDefaultText();
      KJ_ASSERT(shortDescription.size() > 0 && shortDescription.size() < 25,
          "bad shortDescription; please provide a 1-to-3 word short description to display "
          "under the app title, e.g. \"Document editor\"");

      KJ_IF_MAYBE(previous, sandstorm::raiiOpenIfExists(
          kj::str("/var/apps/", appIdString(info.getAppId()), "/metadata"), O_RDONLY)) {
        capnp::StreamFdMessageReader reader(previous->get());
        auto previouslyPublished = reader.getRoot<spk::VerifiedInfo>();
        KJ_ASSERT(info.getVersion() > previouslyPublished.getVersion(),
            "oops, it looks like you forgot to bump appVersion -- it must be greater than the "
            "previous published version of this app", previouslyPublished.getVersion());
      }

      auto packageDir = kj::str("/var/packages/", packageIdString(info.getPackageId()));
      auto spkFilename = kj::str(packageDir, "/spk");
      if (access(spkFilename.cStr(), F_OK) < 0) {
        mkdir(packageDir.cStr(), 0777);

        {
          StagingFile metadataFile(packageDir);
          capnp::writeMessageToFd(metadataFile.getFd(), infoMessage);
          metadataFile.finalize(kj::str(packageDir, "/metadata"));
        }

        {
          capnp::MallocMessageBuilder statusMessage;
          statusMessage.initRoot<SubmissionStatus>();  // default content is what we want
          StagingFile statusFile(packageDir);
          capnp::writeMessageToFd(statusFile.getFd(), statusMessage);
          statusFile.finalize(kj::str(packageDir, "/status"));
        }

        // Finalize the spk last because its existence implies that the metadata and status already
        // exist.
        spkFile.finalize(spkFilename);

        // TODO(soon): Check keybase info.
      }
    });
  }

private:
  StagingFile spkFile;
  kj::PromiseFulfillerPair<void> doneCalledPaf = kj::newPromiseAndFulfiller<void>();
  bool doneCalled = false;
  bool getResultCalled = false;
};

AppIndex::UploadStream::Client Indexer::newUploadStream() {
  return kj::heap<UploadStreamImpl>();
}

kj::Promise<void> Indexer::upload(UploadContext context) {
  context.getResults(capnp::MessageSize { 4, 1 }).setStream(newUploadStream());
  return kj::READY_NOW;
}

} // namespace appindex
} // namespace sandstorm
