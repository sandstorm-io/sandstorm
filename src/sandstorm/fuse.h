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

#ifndef SANDSTORM_FUSE_H_
#define SANDSTORM_FUSE_H_

#include <kj/time.h>
#include <kj/io.h>
#include <kj/function.h>
#include <kj/refcount.h>
#include <kj/async.h>

namespace kj { class UnixEventPort; }

namespace sandstorm {
namespace fuse {

class File;
class Directory;

class Node {
public:
  virtual kj::Own<Node> addRef() = 0;

  struct LookupResults {
    kj::Own<Node> node;
    uint64_t ttl;
  };

  virtual kj::Maybe<LookupResults> lookup(kj::StringPtr name) = 0;

  enum class Type {
    UNKNOWN = 0,
    BLOCK_DEVICE = 1,
    CHARACTER_DEVICE = 2,
    DIRECTORY = 3,
    FIFO = 4,
    SYMLINK = 5,
    REGULAR = 6,
    SOCKET = 7,
  };

  struct Attributes {
    uint64_t inodeNumber;
    Type type;
    uint32_t permissions;
    uint32_t linkCount;
    uint32_t ownerId;
    uint32_t groupId;
    uint32_t deviceMajor;
    uint32_t deviceMinor;
    uint64_t size;
    uint64_t blockCount;
    uint32_t blockSize;
    int64_t lastAccessTime;
    int64_t lastModificationTime;
    int64_t lastStatusChangeTime;
  };

  struct GetAttributesResults {
    Attributes attributes;
    uint64_t ttl;
  };

  virtual GetAttributesResults getAttributes() = 0;
  virtual kj::Maybe<kj::Own<File>> openAsFile() = 0;
  virtual kj::Maybe<kj::Own<Directory>> openAsDirectory() = 0;
  virtual kj::String readlink() = 0;
};

class File {
public:
  virtual kj::Own<File> addRef() = 0;
  virtual kj::Array<uint8_t> read(uint64_t offset, uint32_t size) = 0;
};

class Directory {
public:
  virtual kj::Own<Directory> addRef() = 0;

  struct Entry {
    uint64_t inodeNumber;
    uint64_t nextOffset;
    Node::Type type;
    kj::String name;
  };

  virtual kj::Array<Entry> read(uint64_t offset, uint32_t count) = 0;
};

} // namespace fuse

struct FuseOptions {
  bool cacheForever = false;
  // Set true to ignore the TTL values returned by the filesystem implementation and instead
  // assume for caching purposes that content never changes. In addition to ignoring TTLs, the
  // page cache will not be flushed when a file is reopened.
};

kj::Promise<void> bindFuse(kj::UnixEventPort& eventPort, int fuseFd, kj::Own<fuse::Node> root,
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

kj::Own<fuse::Node> newLoopbackFuseNode(kj::StringPtr path, kj::Duration cacheTtl);
// Returns a "loopback" fuse node which simply mirrors the directory (or file) at the given path.
// Throws an exception if the path doesn't exist.
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
  KJ_DISALLOW_COPY(FuseMount);

  inline int getFd() { return fd; }
  inline kj::AutoCloseFd disownFd() { return kj::mv(fd); }

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
