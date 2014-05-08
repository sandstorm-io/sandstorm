// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

#ifndef SANDSTORM_UNION_FS_H_
#define SANDSTORM_UNION_FS_H_
// This module implements the machinery for the unioning filesystem that we use to implement
// "spk dev" and build dependency lists.

#include <sandstorm/fuse.capnp.h>
#include <sandstorm/package.capnp.h>
#include <kj/function.h>

namespace sandstorm {

fuse::Node::Client makeUnionFs(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap,
                               spk::Manifest::Reader manifest, kj::StringPtr bridgePath,
                               kj::Function<void(kj::StringPtr)>& callback);
// Creates a new filesystem based os `sourceMap`. Whenever a file is opened (for the first time),
// `callback` will be invoked with the (virtual) path name.
//
// `manifest` is used to populate the special file `/sandstorm-manifest`, and `bridgePath` is the
// file that should be mapped as `/sandstorm-http-bridge`.
//
// `sourceMap` must remain valid until the returned node is destroyed.

kj::Maybe<kj::String> mapFile(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap,
                              kj::StringPtr virtualPath);
// Maps one file from virtual path to real path.

}  // namespace sandstorm

#endif // SANDSTORM_UNION_FS_H_
