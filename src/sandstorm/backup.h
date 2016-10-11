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

#ifndef SANDSTORM_BACKUP_H_
#define SANDSTORM_BACKUP_H_

#include "abstract-main.h"
#include <kj/io.h>
#include <unistd.h>

namespace sandstorm {

class BackupMain: public AbstractMain {
  // The main class for the "backup" command, which creates or restores a grain backup.
public:
  BackupMain(kj::ProcessContext& context);

  kj::MainFunc getMain() override;

  bool setRestore();
  bool setFile(kj::StringPtr arg);
  bool setRoot(kj::StringPtr arg);
  bool setUid(kj::StringPtr arg);
  bool run(kj::StringPtr grainDir);

private:
  kj::ProcessContext& context;
  bool restore = false;
  kj::StringPtr filename;
  kj::StringPtr root = "";
  kj::Maybe<uid_t> sandboxUid;

  void writeSetgroupsIfPresent(const char *contents);
  void writeUserNSMap(const char *type, kj::StringPtr contents);
  void bind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags);
  static void pump(kj::InputStream& in, kj::OutputStream& out);
  bool findFilesToZip(kj::StringPtr path, kj::OutputStream& out);
};

} // namespace sandstorm

#endif // SANDSTORM_BACKUP_H_
