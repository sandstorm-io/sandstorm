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

#ifndef SANDSTORM_FUSE_H_
#define SANDSTORM_FUSE_H_

#include <sandstorm/fuse.capnp.h>
#include <kj/time.h>
#include <kj/io.h>

namespace kj { class UnixEventPort; }

namespace sandstorm {

struct FuseOptions {
  bool cacheForever = false;
  // Set true to ignore the TTL values returned by the filesystem implementation and instead
  // assume for caching purposes that content never changes. In addition to ignoring TTLs, the
  // page cache will not be flushed when a file is reopened.
};

kj::Promise<void> bindFuse(kj::UnixEventPort& eventPort, int fuseFd, fuse::Node::Client root,
                           FuseOptions options = FuseOptions());
// Export the filesystem represented by `root` on the given /dev/fuse file descriptor.
//
// It is the caller's responsibility to open the device and mount it, either directly or via the
// `fusermount` helper program.
//
// The promise completes successfully when FUSE_DESTROY is received, or throws an exception in case
// of errors reading/writing the FUSE device itself or if a message received from the device
// appears malformed.
//
// Exceptions thrown by RPC method calls made in response to FUSE requests are of course reported as
// errors via FUSE and do not break the overall connection.  At present we don't have a good way
// to map KJ/Cap'n Proto exceptions back to system error codes, so each syscall has a "default"
// error code that it returns for all errors.  In the future, this situation may be improved if
// kj::Exception gains a notion of error codes and error code namespaces.

fuse::Node::Client newLoopbackFuseNode(kj::StringPtr path, kj::Duration cacheTtl);
// Returns a "loopback" fuse node which simply mirrors the directory at the given path. Throws an
// exception if the path doesn't exist.
//
// `cacheTtl` is the amount of time for which callers are allowed to cache path lookups and
// attributes. It is OK to set this to zero, but performance will be reduced.
//
// At present this node and nodes created from it store their paths as strings. This means that
// if the underlying filesystem changes, an existing node could become invalid, leading its methods
// to throw exceptions. In the future, the implementation may change to open a file descriptor to
// each directory as each node is created and use the "at" versions of all filesystem calls. This
// risks running up against the ulimits, however.

class FuseMount {
  // Uses fusermount(1) to create a FUSE mount and get a file descriptor for it. Unmounts in the
  // destructor.
public:
  FuseMount(kj::StringPtr path, kj::StringPtr options);
  ~FuseMount() noexcept(false);

  inline int getFd() { return fd; }

  void dontUnmount() { path = nullptr; }
  // Prevents FuseMount from attempting to unmount itself in the destructor. Useful if you passed
  // the FD away to another process, or if bindFuse() completed successfully indicating that the
  // fuse was unmounted by someone else.

private:
  kj::String path;
  kj::AutoCloseFd fd;
};

}  // namespace sandstorm

#endif // SANDSTORM_FUSE_H_
