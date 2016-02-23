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

#ifndef SANDSTORM_APPINDEX_INDEXER_H_
#define SANDSTORM_APPINDEX_INDEXER_H_

#include <kj/common.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/util.h>
#include <sandstorm/app-index/submit.capnp.h>

namespace sandstorm {
namespace appindex {

class Indexer: public AppIndex::Server {
public:
  void addKeybaseProfile(kj::StringPtr fingerprint, capnp::MallocMessageBuilder& message);

  bool tryGetPublicKey(kj::StringPtr packageId, byte publicKey[32]);
  // Get the public key which is allowed to submit requests modifying the given package's state.

  void approve(kj::StringPtr packageId, kj::StringPtr url);
  void unapprove(kj::StringPtr packageId);
  void reject(kj::StringPtr packageId, kj::StringPtr reason);
  bool setSubmissionState(kj::StringPtr packageId, SubmissionState state, uint64_t sequence);
  // Modify the status of some package.

  void getSubmissionStatus(kj::StringPtr packageId, capnp::MessageBuilder& output);

  void updateIndex();
  // Rebuild the main index.

  kj::String getReviewQueueJson();

  kj::String getAppTitle(kj::StringPtr packageId);

  AppIndex::Submission::Client getSubmission(spk::PackageId::Reader packageId);
  // Temporary interface allowing caller to get access to Submission capability. Only callable
  // in-process. The caller is expected to verify signatures by checking the app ID. Eventually
  // this will be replaced by a Cap'n Proto interface.

  AppIndex::UploadStream::Client newUploadStream();

protected:
  // implements AppIndex -------------------------------------------------------
  kj::Promise<void> upload(UploadContext context) override;

private:
  class UploadStreamImpl;

  kj::String writeIcon(spk::Metadata::Icon::Reader icon);
  kj::String writeScreenshot(spk::Metadata::Screenshot::Reader screenshot);
  kj::String writeImage(kj::ArrayPtr<const byte> data, kj::StringPtr extension);
  capnp::Text::Reader categoryName(spk::Category category);

  void updateIndexInternal(kj::StringPtr outputDir, bool experimental);
};

} // namespace appindex
} // namespace sandstorm

#endif // SANDSTORM_APPINDEX_INDEXER_H_
