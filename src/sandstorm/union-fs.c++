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

#include "union-fs.h"
#include <kj/vector.h>
#include <kj/debug.h>
#include <capnp/serialize.h>
#include <map>
#include <set>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <stdlib.h>
#include "fuse.h"
#include "util.h"

namespace sandstorm {
namespace {

typedef unsigned int uint;

class DelegatingNode: public fuse::Node, public kj::Refcounted {
  // A node that delegates all method calls to some other node.

public:
  explicit DelegatingNode(kj::Own<fuse::Node>&& delegate): delegate(kj::mv(delegate)) {}

  kj::Own<fuse::Node> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    return delegate->lookup(name);
  }

  GetAttributesResults getAttributes() override {
    return delegate->getAttributes();
  }

  kj::Maybe<kj::Own<fuse::File>> openAsFile() override {
    return delegate->openAsFile();
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    return delegate->openAsDirectory();
  }

  kj::String readlink() override {
    return delegate->readlink();
  }

protected:
  kj::Own<fuse::Node> delegate;
};

class SimpleDirectory: public fuse::Directory, public kj::Refcounted {
  // Implementation of fuse::Directory that is easier to implement because it just calls a
  // method that returns the whole content as an array.

public:
  struct SimpleEntry {
    uint64_t inodeNumber = 1;  // Kernel refuses to display inode = 0 for whatever reason.
    kj::String name;
    fuse::Node::Type type;
  };

  kj::Own<fuse::Directory> addRef() override {
    return kj::addRef(*this);
  }

  virtual kj::Array<SimpleEntry> simpleRead() = 0;
  // Read the complete contents of the directory.

  static kj::Array<SimpleEntry> readFrom(
      fuse::Directory& directory, uint64_t offset = 0,
      kj::Vector<SimpleEntry>&& alreadyRead = kj::Vector<SimpleEntry>(16)) {
    // Convenience to read the contents of some other directory. Adds all entries to *alreadyRead.

    static const uint DEFAULT_COUNT = 128;
    auto entries = directory.read(offset, DEFAULT_COUNT);

    uint64_t newOffset = 0;
    for (auto& entry: entries) {
      alreadyRead.add(SimpleEntry {
          entry.inodeNumber,
            kj::heapString(entry.name),
            entry.type
            });
        newOffset = entry.nextOffset;
    }

    if (entries.size() == DEFAULT_COUNT) {
      // Could be more to read.
      return readFrom(directory, newOffset, kj::mv(alreadyRead));
    } else {
      return alreadyRead.releaseAsArray();
    }
  }

protected:
  kj::Array<Entry> read(uint64_t offset, uint32_t count) override {
    KJ_IF_MAYBE(c, cachedResults) {
      return fillResponse(offset, count, *c);
    } else {
      auto entries = simpleRead();
      auto result = fillResponse(offset, count, entries);
      cachedResults = kj::mv(entries);
      return result;
    }
  }

private:
  kj::Maybe<kj::Array<SimpleEntry>> cachedResults;

  static kj::Array<Entry> fillResponse(uint64_t offset, uint32_t count,
                                       const kj::Array<SimpleEntry>& entries) {
    // Slice down to the list we're returning now.
    auto startOffset = kj::min(entries.size(), offset);
    auto slice = entries.slice(startOffset, entries.size());
    slice = slice.slice(0, kj::min(slice.size(), count));

    // Fill in results.
    kj::Array<Entry> results = kj::heapArray<Entry>(slice.size());
    for (size_t i: kj::indices(slice)) {
      auto& entry = slice[i];

      results[i].inodeNumber = entry.inodeNumber;
      results[i].nextOffset = startOffset + i + 1;
      results[i].type = entry.type;
      results[i].name = kj::str(entry.name);
    }

    return results;
  }
};

class UnionDirectory final: public SimpleDirectory {
  // Directory that merges the contents of several directories.

public:
  explicit UnionDirectory(kj::Array<kj::Own<fuse::Directory>>&& layers)
      : layers(kj::mv(layers)) {}

  kj::Array<SimpleEntry> simpleRead() override {
    // Read from each delegate.
    std::map<kj::StringPtr, SimpleEntry> entryMap;
    for (auto& layer: layers) {
      auto sublist = readFrom(*layer);
      for (auto& entry: sublist) {
        entryMap.insert(std::make_pair(kj::StringPtr(entry.name), kj::mv(entry)));
      }
    }

    auto results = kj::heapArrayBuilder<SimpleEntry>(entryMap.size());
    for (auto& mapEntry: entryMap) {
      results.add(kj::mv(mapEntry.second));
    }

    return results.finish();
  }

private:
  kj::Array<kj::Own<fuse::Directory>> layers;
};

class UnionNode final: public DelegatingNode {
  // Merges several nodes into one.

public:
  explicit UnionNode(kj::Array<kj::Own<fuse::Node>> layers)
    : DelegatingNode(layers[0]->addRef()), layers(kj::mv(layers)) {}

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {

    // Forward the lookup request to each node in our list.
    kj::Vector<kj::Own<fuse::Node>> outLayers(layers.size());
    uint64_t ttl = kj::maxValue;
    for (auto& layer: layers) {
      auto maybeLayer = layer->lookup(name);
      KJ_IF_MAYBE(newLayer, maybeLayer) {
        outLayers.add(newLayer->node->addRef());
        ttl = kj::min(ttl, newLayer->ttl);
      }

    }

    if (outLayers.size() == 0) {
      return nullptr;
    } else {
      return LookupResults { kj::refcounted<UnionNode>(outLayers.releaseAsArray()), ttl };
    }
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    // Call openAsDirectory() on all children and then return a UnionDirectory of the pipelined
    // results. No need to wait; if pipelined requests on the layers fail then we simply treat
    // them as empty directories anyway.

    auto dirLayers = kj::heapArrayBuilder<kj::Own<fuse::Directory>>(layers.size());
    for (auto& layer: layers) {
      auto maybeAsDir = layer->openAsDirectory();
      KJ_IF_MAYBE(asDir, maybeAsDir) {
        dirLayers.add(kj::mv(*asDir));
      }
    }

    kj::Own<fuse::Directory> result = kj::refcounted<UnionDirectory>(dirLayers.finish());
    return kj::mv(result);
  }

private:
  kj::Array<kj::Own<fuse::Node>> layers;
};

class HidingDirectory final: public SimpleDirectory {
  // Directory that filters out a set of hidden paths from its contents.

public:
  HidingDirectory(kj::Own<fuse::Directory> delegate, std::set<kj::StringPtr> hidePaths)
      : delegate(kj::mv(delegate)), hidePaths(kj::mv(hidePaths)) {}

  kj::Array<SimpleEntry> simpleRead() override {
    auto entries = readFrom(*delegate);
    kj::Vector<SimpleEntry> outEntries(entries.size());

    for (auto& entry: entries) {
      if (hidePaths.count(entry.name) == 0) {
        outEntries.add(kj::mv(entry));
      }
    }

    return outEntries.releaseAsArray();
  }

private:
  kj::Own<fuse::Directory> delegate;
  std::set<kj::StringPtr> hidePaths;
};

class HidingNode final: public DelegatingNode {
  // A node which hides some set of its contents.

public:
  HidingNode(kj::Own<fuse::Node>&& delegate, std::set<kj::StringPtr> hidePaths)
    : DelegatingNode(kj::mv(delegate)), hidePaths(kj::mv(hidePaths)) {}

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    if (hidePaths.count(name) != 0) {
      return nullptr;
    }

    auto maybeResult = delegate->lookup(name);

    KJ_IF_MAYBE(result, maybeResult) {

      std::set<kj::StringPtr> subHides;
      for (auto& hidden: hidePaths) {
        if (hidden.size() > name.size() &&
            hidden.startsWith(name) &&
            hidden[name.size()] == '/') {
          subHides.insert(hidden.slice(name.size() + 1));
        }
      }

      return LookupResults { kj::refcounted<HidingNode>(kj::mv(result->node), kj::mv(subHides)), result->ttl };
    } else {
      return nullptr;
    }
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    KJ_IF_MAYBE(delegate, DelegatingNode::openAsDirectory()) {
      kj::Own<fuse::Directory> result =
          kj::refcounted<HidingDirectory>(kj::mv(*delegate), hidePaths);
      return kj::mv(result);
    } else {
      return nullptr;
    }
  }

private:
  std::set<kj::StringPtr> hidePaths;
};

class TrackingNode final: public DelegatingNode {
  // A node which tracks what nodes are ultimately opened.

public:
  TrackingNode(kj::Own<fuse::Node> delegate, kj::String path,
               kj::Function<void(kj::StringPtr)>& callback)
    : DelegatingNode(kj::mv(delegate)), path(kj::mv(path)), callback(callback) {}

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    auto subPath = path == nullptr ? kj::heapString(name) : kj::str(path, '/', name);
    auto maybeResponse = delegate->lookup(name);
    KJ_IF_MAYBE(response, maybeResponse) {
      auto& callback = this->callback;
      return LookupResults {
        kj::refcounted<TrackingNode>(kj::mv(response->node), kj::mv(subPath), callback),
          response->ttl
          };
    } else {
      return nullptr;
    }
  }

  GetAttributesResults getAttributes() override {
    // Normally, we don't want to mark a file as "used" just because it was stat()ed, because it
    // is normal to stat() every file in a directory when listing that directory, and this doesn't
    // necessarily mean the file is used by the app. However, we make a special exception for
    // zero-sized regular files because:
    // - Their mere presence _probably_ means something, since their content certainly doesn't.
    // - Since they're zero-size, they won't significantly bloat the package.
    //
    // In particular, RubyGems has been observed to care about the presence or absence of zero-size
    // ".build_complete" files.

    auto subresult = delegate->getAttributes();
    auto& attributes = subresult.attributes;
    if (attributes.type == fuse::Node::Type::REGULAR && attributes.size == 0) {
      markUsed();
    }
    return subresult;
  }

  kj::Maybe<kj::Own<fuse::File>> openAsFile() override {
    markUsed();
    return DelegatingNode::openAsFile();
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    markUsed();
    return DelegatingNode::openAsDirectory();
  }

  kj::String readlink() override {
    markUsed();
    return DelegatingNode::readlink();
  }

private:
  kj::String path;
  bool isUsed = false;
  kj::Function<void(kj::StringPtr)>& callback;

  void markUsed() {
    if (!isUsed) {
      isUsed = true;
      if (path != nullptr) {
        callback(path);
      }
    }
  }
};

class SingletonDirectory final: public SimpleDirectory {
public:
  explicit SingletonDirectory(kj::StringPtr path): path(path) {}

  kj::Array<SimpleEntry> simpleRead() override {
    auto result = kj::heapArray<SimpleEntry>(3);

    result[0].name = kj::str(".");
    result[0].type = fuse::Node::Type::DIRECTORY;
    result[1].name = kj::str("..");
    result[1].type = fuse::Node::Type::DIRECTORY;

    KJ_IF_MAYBE(slashPos, path.findFirst('/')) {
      result[2].name = kj::heapString(path.slice(0, *slashPos));
    } else {
      result[2].name = kj::heapString(path);
    }
    result[2].type = fuse::Node::Type::DIRECTORY;

    return kj::mv(result);
  }

private:
  kj::StringPtr path;
};

class SingletonNode final: public fuse::Node, public kj::Refcounted {
  // A directory node which contains only one member mapped at some path.

public:
  SingletonNode(kj::Own<fuse::Node> member, kj::StringPtr path)
      : member(kj::mv(member)), path(path) {}

  kj::Own<fuse::Node> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    if (path.startsWith(name)) {
      auto sub = path.slice(name.size());
      if (sub.size() == 0) {
        // This is the exact path.
        return LookupResults { member->addRef(), kj::maxValue };
      } else if (sub.startsWith("/")) {
        sub = sub.slice(1);
        return LookupResults { kj::refcounted<SingletonNode>(member->addRef(), sub), kj::maxValue };
      }
    }

    return nullptr;
  }

  GetAttributesResults getAttributes() override {

    auto result = GetAttributesResults {};
    result.ttl = kj::maxValue;
    auto& attr = result.attributes;

    attr.inodeNumber = 0;
    attr.type = fuse::Node::Type::DIRECTORY;
    attr.permissions = 0555;
    attr.linkCount = 1;

    return result;
  }

  kj::Maybe<kj::Own<fuse::File>> openAsFile() override {
    return nullptr;
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    kj::Own<fuse::Directory> result = kj::refcounted<SingletonDirectory>(path);
    return kj::mv(result);
  }

  kj::String readlink() override {
    KJ_FAIL_REQUIRE("not a symlink");
  }

private:
  kj::Own<fuse::Node> member;
  kj::StringPtr path;
};

class EmptyDirectory final: public SimpleDirectory {
public:
  EmptyDirectory() = default;

  kj::Array<SimpleEntry> simpleRead() override {
    auto result = kj::heapArray<SimpleEntry>(2);

    result[0].name = kj::str(".");
    result[0].type = fuse::Node::Type::DIRECTORY;
    result[1].name = kj::str("..");
    result[1].type = fuse::Node::Type::DIRECTORY;

    return kj::mv(result);
  }
};

class EmptyNode final: public fuse::Node {
  // A directory node which contains nothing.

public:
  EmptyNode() = default;


  kj::Own<fuse::Node> addRef() override {
    return kj::heap<EmptyNode>();
  }

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    return nullptr;
  }

  GetAttributesResults getAttributes() override {
    auto results = GetAttributesResults {};
    results.ttl = kj::maxValue;
    auto& attr = results.attributes;

    attr.inodeNumber = 0;
    attr.type = fuse::Node::Type::DIRECTORY;
    attr.permissions = 0555;
    attr.linkCount = 1;

    return results;
  }

  kj::Maybe<kj::Own<fuse::File>> openAsFile() override {
    return nullptr;
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    kj::Own<fuse::Directory> result = kj::refcounted<EmptyDirectory>();
    return kj::mv(result);
  }

  kj::String readlink() override {
    KJ_FAIL_REQUIRE("not a symlink");
  }
};

class SimpleDataFile final: public fuse::File, public kj::Refcounted {
public:
  SimpleDataFile(kj::ArrayPtr<const capnp::word> data)
      : data(kj::arrayPtr(reinterpret_cast<const kj::byte*>(data.begin()),
                          data.size() * sizeof(capnp::word))) {}

  kj::Own<fuse::File> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Array<uint8_t> read(uint64_t offset0, uint32_t size0) override {
    auto offset = kj::min(data.size(), offset0);
    auto size = kj::min(data.size() - offset, size0);
    return kj::heapArray(data.slice(offset, offset + size));
  }

private:
  kj::ArrayPtr<const kj::byte> data;
};

class SimpleDataNode final: public fuse::Node, public kj::Refcounted {
  // A node wrapping a byte array and exposing it as a file.

public:
  SimpleDataNode(kj::Array<capnp::word> data): data(kj::mv(data)) {}

  kj::Own<fuse::Node> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    return nullptr;
  }

  GetAttributesResults getAttributes() override {
    auto result = GetAttributesResults {};
    result.ttl = kj::maxValue;
    auto& attr = result.attributes;
    attr.inodeNumber = 0;
    attr.type = fuse::Node::Type::REGULAR;
    attr.permissions = 0444;
    attr.linkCount = 1;
    attr.size = data.size() * sizeof(capnp::word);

    return result;
  }

  kj::Maybe<kj::Own<fuse::File>> openAsFile() override {
    kj::Own<fuse::File> result = kj::refcounted<SimpleDataFile>(data);
    return kj::mv(result);
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    return nullptr;
  }

  kj::String readlink() override {
    KJ_FAIL_REQUIRE("not a symlink");
  }

private:
  kj::Array<capnp::word> data;
};

}  // namespace

kj::Own<fuse::Node> makeUnionFs(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap,
                               spk::Manifest::Reader manifest,
                               spk::BridgeConfig::Reader bridgeConfig, kj::StringPtr bridgePath,
                               kj::Function<void(kj::StringPtr)>& callback) {
  auto searchPath = sourceMap.getSearchPath();
  auto layers = kj::Vector<kj::Own<fuse::Node>>(searchPath.size() + 10);

  {
    capnp::MallocMessageBuilder manifestCopy(manifest.totalSize().wordCount + 4);
    manifestCopy.setRoot(manifest);
    layers.add(kj::refcounted<SingletonNode>(kj::refcounted<SimpleDataNode>(
        capnp::messageToFlatArray(manifestCopy)), "sandstorm-manifest"));
  }

  {
    capnp::MallocMessageBuilder bridgeConfigCopy(bridgeConfig.totalSize().wordCount + 4);
    bridgeConfigCopy.setRoot(bridgeConfig);
    layers.add(kj::refcounted<SingletonNode>(kj::refcounted<SimpleDataNode>(
        capnp::messageToFlatArray(bridgeConfigCopy)), "sandstorm-http-bridge-config"));
  }

  layers.add(kj::refcounted<SingletonNode>(
      newLoopbackFuseNode(bridgePath, kj::maxValue), "sandstorm-http-bridge"));

  layers.add(kj::refcounted<SingletonNode>(kj::heap<EmptyNode>(), "dev"));
  layers.add(kj::refcounted<SingletonNode>(kj::heap<EmptyNode>(), "tmp"));
  layers.add(kj::refcounted<SingletonNode>(kj::heap<EmptyNode>(), "var"));

  // Empty /proc/cpuinfo will be overmounted by the supervisor.
  layers.add(kj::refcounted<SingletonNode>(kj::refcounted<SimpleDataNode>(nullptr), "proc/cpuinfo"));

  for (auto mapping: searchPath) {
    kj::StringPtr sourcePath = mapping.getSourcePath();
    kj::String ownSourcePath;
    kj::StringPtr packagePath = mapping.getPackagePath();

    // Interpret relative paths against the source dir (if it's not the current directory).
    if (sourceDir.size() != 0 && !sourcePath.startsWith("/")) {
      ownSourcePath = kj::str(sourceDir, '/', sourcePath);
      sourcePath = ownSourcePath;
    }

    // If this is a symlink mapped to virtual root, follow it, because it makes no sense for
    // root to be a symlink.
    if (packagePath.size() == 0) {
      struct stat stats;
      KJ_SYSCALL(lstat(sourcePath.cStr(), &stats), sourcePath);
      if (S_ISLNK(stats.st_mode)) {
        char* real = realpath(sourcePath.cStr(), NULL);
        if (real == NULL) {
          KJ_FAIL_SYSCALL("realpath(sourcePath)", errno, sourcePath);
        }
        KJ_DEFER(free(real));
        ownSourcePath = kj::str(real);
        sourcePath = ownSourcePath;
      }
    }

    // Create the filesystem node.
    // We set a low TTL here, but note that the spk tool overrides it anyway.
    kj::Own<fuse::Node> node = newLoopbackFuseNode(sourcePath, 1 * kj::SECONDS);

    // If any contents are hidden, wrap in a hiding node.
    auto hides = mapping.getHidePaths();
    if (hides.size() > 0) {
      std::set<kj::StringPtr> hideSet;
      for (auto hide: hides) {
        hideSet.insert(hide);
      }
      node = kj::refcounted<HidingNode>(kj::mv(node), kj::mv(hideSet));
    }

    // If the contents are mapped to a non-root location, wrap in a singleton node.
    KJ_ASSERT(!packagePath.startsWith("/"),
              "`packagePath` in source map should not start with '/'.");
    if (packagePath.size() > 0) {
      node = kj::refcounted<SingletonNode>(kj::mv(node), packagePath);
    }

    layers.add(kj::mv(node));
  }

  auto merged = kj::refcounted<UnionNode>(layers.releaseAsArray());
  return kj::refcounted<TrackingNode>(kj::mv(merged), nullptr, callback);
}

static kj::String joinPaths(kj::StringPtr a, kj::StringPtr b) {
  // e.g. joinPaths("foo", "bar") -> "foo/bar".
  //
  // Special rules:
  // - An empty operand is equivalent to ".", therefore we return the other operand.
  // - If the right operand is absolute, we just return it.
  // - We try to avoid adding redundant slashes, especially for the case where the left operand
  //   is "/".

  if (b.startsWith("/")) return kj::str(b);

  if (a.endsWith("/") || a.size() == 0 || b.size() == 0) {
    return kj::str(a, b);
  }

  return kj::str(a, '/', b);
}

static kj::Maybe<kj::StringPtr> tryRemovePathPrefix(kj::StringPtr path, kj::StringPtr prefix) {
  // If `prefix` names a parent directory of `path`, then return the remainder of `path` after
  // removing said parent. Otherwise return null.
  //
  // Special rules:
  // - It can't merely be a string prefix, because the prefix must be a whole node name. E.g.
  //   "foo" is a prefix of "foo/bar" but not of "foobar/baz".
  // - An empty `prefix` means "current directory" and so is always matched unless `path` is
  //   absolute.
  // - An exact match returns an empty string.

  if (!path.startsWith(prefix)) {
    return nullptr;
  }

  if (prefix.size() == 0) {
    // Empty prefix = current dir.
    if (path.startsWith("/")) {
      return nullptr;
    } else {
      return path;
    }
  }

  if (path.size() == prefix.size()) {
    // Exact match.
    return kj::StringPtr("");
  }

  if (path[prefix.size()] == '/') {
    // Path prefix match. Strip off prefix and slash.
    return path.slice(prefix.size() + 1);
  } else {
    // It's a string prefix match but not a path prefix match.
    return nullptr;
  }
}

FileMapping mapFile(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap, kj::StringPtr name) {
  kj::Vector<kj::String> matches;
  kj::Vector<kj::String> virtualChildren;

  for (auto dir: sourceMap.getSearchPath()) {
    auto virtualPath = dir.getPackagePath();
    KJ_IF_MAYBE(subPath, tryRemovePathPrefix(name, virtualPath)) {
      // If the path is some file or subdirectory inside the virtual path...
      if (subPath->size() > 0) {
        // ... then check to see if it's hidden.
        bool hidden = false;
        for (auto hide: dir.getHidePaths()) {
          if (tryRemovePathPrefix(*subPath, hide) != nullptr) {
            hidden = true;
            break;
          }
        }
        if (hidden) continue;
      }

      // Not hidden, so now check if this path exists.
      auto sourcePath = dir.getSourcePath();
      auto candidate = joinPaths(sourcePath, *subPath);

      // Prepend `sourceDir` to relative paths.
      candidate = joinPaths(sourceDir, candidate);

      if (faccessat(AT_FDCWD, candidate.cStr(), F_OK, AT_SYMLINK_NOFOLLOW) == 0) {
        // Found!

        if (name.size() == 0) {
          // This is a root mapping. In this case we follow symlinks eagerly.
          struct stat stats;
          KJ_SYSCALL(lstat(candidate.cStr(), &stats));
          if (S_ISLNK(stats.st_mode)) {
            char* real = realpath(candidate.cStr(), NULL);
            if (real == NULL) {
              KJ_FAIL_SYSCALL("realpath(candidate)", errno, candidate);
            }
            KJ_DEFER(free(real));
            candidate = kj::str(real);
          }
        }

        matches.add(kj::mv(candidate));
      }
    } else {
      // virtualPath is not a prefix of `name`, but is `name` a prefix of `virtualPath`?
      KJ_IF_MAYBE(child, tryRemovePathPrefix(virtualPath, name)) {
        // Yep.
        KJ_IF_MAYBE(slashPos, child->findFirst('/')) {
          virtualChildren.add(kj::heapString(child->slice(0, *slashPos)));
        } else {
          virtualChildren.add(kj::heapString(*child));
        }
      }
    }
  }

  return FileMapping {
    matches.releaseAsArray(),
    virtualChildren.releaseAsArray()
  };
}

}  // namespace sandstorm
