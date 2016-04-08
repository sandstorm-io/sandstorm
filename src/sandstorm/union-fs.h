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

#ifndef SANDSTORM_UNION_FS_H_
#define SANDSTORM_UNION_FS_H_
// This module implements the machinery for the unioning filesystem that we use to implement
// "spk dev" and build dependency lists.

#include <sandstorm/fuse.h>
#include <sandstorm/package.capnp.h>
#include <kj/function.h>

namespace sandstorm {

kj::Own<fuse::Node> makeUnionFs(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap,
                               spk::Manifest::Reader manifest, spk::BridgeConfig::Reader bridgeConfig,
                               kj::StringPtr bridgePath, kj::Function<void(kj::StringPtr)>& callback);
// Creates a new filesystem based on `sourceMap`. Whenever a file is opened (for the first time),
// `callback` will be invoked with the (virtual) path name.
//
// `manifest` is used to populate the special file `/sandstorm-manifest`, and `bridgePath` is the
// file that should be mapped as `/sandstorm-http-bridge`.
//
// `sourceMap` must remain valid until the returned node is destroyed.

struct FileMapping {
  kj::Array<kj::String> sourcePaths;
  // All disk paths mapped to the virtual path. If the first turns out to be a file, then the
  // rest should be ignored. But if the first is a directory, it should be merged with all
  // directories belong it and also virtualChildren.

  kj::Array<kj::String> virtualChildren;
  // Names of child nodes which do not exist on-disk but are virtually mapped to things. If the
  // mapping is a directory, these nodes need to be merged into the directory.
};

FileMapping mapFile(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap,
                    kj::StringPtr virtualPath);
// Maps one file from virtual path to real path. Returns a list of all matching real paths. In
// the case of a file, the first should be used, but in the case of a directory, they should be
// merged.

}  // namespace sandstorm

#endif // SANDSTORM_UNION_FS_H_
