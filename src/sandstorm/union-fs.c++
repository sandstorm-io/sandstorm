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

#include "union-fs.h"
#include <kj/vector.h>
#include <kj/debug.h>
#include <capnp/serialize.h>
#include <map>
#include <set>
#include "fuse.h"

#if __QTCREATOR
#define KJ_MVCAP(var) var
// QtCreator dosen't understand C++14 syntax yet.
#else
#define KJ_MVCAP(var) var = ::kj::mv(var)
// Capture the given variable by move.  Place this in a lambda capture list.  Requires C++14.
//
// TODO(cleanup):  Move to libkj.
#endif

namespace sandstorm {
namespace {

typedef unsigned int uint;

class DelegatingNode: public fuse::Node::Server {
  // A node that delegates all method calls to some other node.
  //
  // TODO(cleanup): Cap'n Proto should have a more general way to do this.

public:
  explicit DelegatingNode(fuse::Node::Client delegate): delegate(kj::mv(delegate)) {}

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    // TODO(cleanup): Extend Cap'n Proto with a better way to delegate requests.
    // TODO(cleanup): Above TODO applies to other methods as well.
    auto params = context.getParams();
    auto subRequest = delegate.lookupRequest(params.totalSize());
    subRequest.setName(params.getName());
    return context.tailCall(kj::mv(subRequest));
  }

  kj::Promise<void> getAttributes(GetAttributesContext context) override {
    return context.tailCall(delegate.getAttributesRequest(context.getParams().totalSize()));
  }

  kj::Promise<void> openAsFile(OpenAsFileContext context) override {
    return context.tailCall(delegate.openAsFileRequest(context.getParams().totalSize()));
  }

  kj::Promise<void> openAsDirectory(OpenAsDirectoryContext context) override {
    return context.tailCall(delegate.openAsDirectoryRequest(context.getParams().totalSize()));
  }

  kj::Promise<void> readlink(ReadlinkContext context) override {
    return context.tailCall(delegate.readlinkRequest(context.getParams().totalSize()));
  }

protected:
  fuse::Node::Client delegate;
};

class SimpleDirecotry: public fuse::Directory::Server {
  // Implementation of fuse::Directory that is easier to implement because it just calls a
  // method that returns the whole content as an array.

public:
  struct SimpleEntry {
    uint64_t inodeNumber = 1;  // Kernel refuses to display inode = 0 for whatever reason.
    kj::String name;
    fuse::Node::Type type;
  };

  virtual kj::Promise<kj::Array<SimpleEntry>> simpleRead() = 0;
  // Read the complete contents of the directory.

  static kj::Promise<kj::Array<SimpleEntry>> readFrom(
      fuse::Directory::Client directory, uint64_t offset = 0,
      kj::Vector<SimpleEntry>&& alreadyRead = kj::Vector<SimpleEntry>(16)) {
    // Convenience to read the contents of some other directory. Adds all entries to *target.

    auto request = directory.readRequest();
    request.setOffset(offset);

    static const uint DEFAULT_COUNT = 128;
    request.setCount(DEFAULT_COUNT);

    return request.send().then([KJ_MVCAP(directory), KJ_MVCAP(alreadyRead)](
        capnp::Response<ReadResults>&& response) mutable
        -> kj::Promise<kj::Array<SimpleEntry>> {
      auto entries = response.getEntries();
      uint64_t newOffset = 0;
      for (auto entry: entries) {
        alreadyRead.add(SimpleEntry {
          entry.getInodeNumber(),
          kj::heapString(entry.getName()),
          entry.getType()
        });
        newOffset = entry.getNextOffset();
      }

      if (entries.size() == DEFAULT_COUNT) {
        // Could be more to read.
        return readFrom(kj::mv(directory), newOffset, kj::mv(alreadyRead));
      } else {
        return alreadyRead.releaseAsArray();
      }
    });
  }

protected:
  kj::Promise<void> read(ReadContext context) {
    KJ_IF_MAYBE(c, cachedResults) {
      fillResponse(*c, context);
      return kj::READY_NOW;
    } else {
      return simpleRead().then([this, context](kj::Array<SimpleEntry>&& entries) mutable {
        fillResponse(entries, context);
        cachedResults = kj::mv(entries);
      });
    }
  }

private:
  kj::Maybe<kj::Array<SimpleEntry>> cachedResults;

  static void fillResponse(const kj::Array<SimpleEntry>& entries, ReadContext context) {
    auto params = context.getParams();

    // Slice down to the list we're returning now.
    auto startOffset = kj::min(entries.size(), params.getOffset());
    auto slice = entries.slice(startOffset, entries.size());
    slice = slice.slice(0, kj::min(slice.size(), params.getCount()));

    context.releaseParams();

    // Calculate space needs;
    capnp::MessageSize spaceNeeded = {
      capnp::sizeInWords<ReadResults>() +
          slice.size() * capnp::sizeInWords<fuse::Directory::Entry>(),
      0
    };
    for (auto& entry: slice) {
      spaceNeeded.wordCount += entry.name.size() / sizeof(capnp::word) + 1;
    }

    // Fill in results.
    auto results = context.getResults(spaceNeeded);
    auto builder = results.initEntries(slice.size());
    for (size_t i: kj::indices(slice)) {
      auto entryBuilder = builder[i];
      auto& entry = slice[i];

      entryBuilder.setInodeNumber(entry.inodeNumber);
      entryBuilder.setNextOffset(startOffset + i + 1);
      entryBuilder.setType(entry.type);
      entryBuilder.setName(entry.name);
    }
  }
};

class UnionDirectory final: public SimpleDirecotry {
  // Directory that merges the contents of several directories.

public:
  explicit UnionDirectory(kj::Array<fuse::Directory::Client> layers)
      : layers(kj::mv(layers)) {}

  kj::Promise<kj::Array<SimpleEntry>> simpleRead() override {
    // Read from each delegate.
    auto subRequests =
        kj::heapArrayBuilder<kj::Promise<kj::Array<SimpleEntry>>>(layers.size());
    for (auto& layer: layers) {
      subRequests.add(readFrom(layer).then([](auto&& result) {
        // Success.
        return kj::mv(result);
      }, [](kj::Exception&& exception) {
        // Perhaps this layer is not a directory. Treat it as empty.
        return kj::Array<SimpleEntry>();
      }));
    }

    return kj::joinPromises(subRequests.finish())
        .then([](kj::Array<kj::Array<SimpleEntry>>&& allEntries) {
      // Compile all the sub-lists into a single list, merging duplicate names. In case of dups,
      // we prefer entries from earlier layers.
      std::map<kj::StringPtr, SimpleEntry*> entryMap;

      for (auto& sublist: allEntries) {
        for (auto& entry: sublist) {
          entryMap.insert(std::make_pair(kj::StringPtr(entry.name), &entry));
        }
      }

      auto results = kj::heapArrayBuilder<SimpleEntry>(entryMap.size());
      for (auto& mapEntry: entryMap) {
        results.add(kj::mv(*mapEntry.second));
      }

      return results.finish();
    });
  }

private:
  kj::Array<fuse::Directory::Client> layers;
};

class UnionNode final: public DelegatingNode {
  // Merges several nodes into one.

public:
  explicit UnionNode(kj::Array<fuse::Node::Client> layers)
      : DelegatingNode(layers[0]), layers(kj::mv(layers)) {}

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    auto params = context.getParams();
    auto name = params.getName();
    auto paramsSize = params.totalSize();

    // Forward the lookup request to each node in our list.
    auto promises =
        kj::Vector<kj::Promise<kj::Maybe<capnp::Response<LookupResults>>>>(layers.size());
    for (auto& layer: layers) {
      auto request = layer.lookupRequest(paramsSize);
      request.setName(name);
      promises.add(request.send()
          .then([](capnp::Response<LookupResults>&& results) mutable
                -> kj::Maybe<capnp::Response<LookupResults>> {
        return kj::mv(results);
      }, [](kj::Exception&& e) -> kj::Maybe<capnp::Response<LookupResults>> {
        // Lookup failed. Apparently this node doesn't exist in this layer.
        return nullptr;
      }));
    }

    context.releaseParams();

    return kj::joinPromises(promises.releaseAsArray())
        .then([context](auto&& layerResults) mutable {
      kj::Vector<fuse::Node::Client> outLayers(layerResults.size());
      uint64_t ttl = kj::maxValue;

      for (auto& maybeLayer: layerResults) {
        KJ_IF_MAYBE(layer, maybeLayer) {
          outLayers.add(layer->getNode());
          ttl = kj::min(ttl, layer->getTtl());
        }
      }

      auto outResults = context.getResults(capnp::MessageSize {2, 1});
      outResults.setNode(kj::heap<UnionNode>(outLayers.releaseAsArray()));
      outResults.setTtl(ttl);
    });
  }

  kj::Promise<void> openAsDirectory(OpenAsDirectoryContext context) override {
    // Call openAsDirectory() on all children and then return a UnionDirectory of the pipelined
    // results. No need to wait; if pipelined requests on the layers fail then we simply treat
    // them as empty directories anyway.
    auto dirLayers = kj::heapArrayBuilder<fuse::Directory::Client>(layers.size());
    for (auto& layer: layers) {
      dirLayers.add(layer.openAsDirectoryRequest(capnp::MessageSize {4,0})
          .send().getDirectory());
    }

    context.releaseParams();

    auto results = context.getResults(capnp::MessageSize {4,1});
    results.setDirectory(kj::heap<UnionDirectory>(dirLayers.finish()));
    return kj::READY_NOW;
  }

private:
  kj::Array<fuse::Node::Client> layers;
};

class HidingDirectory final: public SimpleDirecotry {
  // Directory that filters out a set of hidden paths from its contents.

public:
  HidingDirectory(fuse::Directory::Client delegate, std::set<kj::StringPtr> hidePaths)
      : delegate(kj::mv(delegate)), hidePaths(kj::mv(hidePaths)) {}

  kj::Promise<kj::Array<SimpleEntry>> simpleRead() override {
    return readFrom(delegate).then([this](kj::Array<SimpleEntry>&& entries) {
      kj::Vector<SimpleEntry> outEntries(entries.size());

      for (auto& entry: entries) {
        if (hidePaths.count(entry.name) == 0) {
          outEntries.add(kj::mv(entry));
        }
      }

      return outEntries.releaseAsArray();
    });
  }

private:
  fuse::Directory::Client delegate;
  std::set<kj::StringPtr> hidePaths;
};

class HidingNode final: public DelegatingNode {
  // A node which hides some set of its contents.

public:
  HidingNode(fuse::Node::Client delegate, std::set<kj::StringPtr> hidePaths)
      : DelegatingNode(delegate), hidePaths(kj::mv(hidePaths)) {}

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    auto params = context.getParams();
    auto name = params.getName();

    KJ_REQUIRE(hidePaths.count(name) == 0, "path hidden");

    auto subRequest = delegate.lookupRequest(params.totalSize());
    subRequest.setName(name);

    std::set<kj::StringPtr> subHides;
    for (auto& hidden: hidePaths) {
      if (hidden.size() > name.size() &&
          hidden.startsWith(name) &&
          hidden[name.size()] == '/') {
        subHides.insert(hidden.slice(name.size() + 1));
      }
    }

    context.releaseParams();

    return subRequest.send().then([KJ_MVCAP(name), KJ_MVCAP(subHides), context](
        capnp::Response<LookupResults>&& results) mutable {
      auto outResults = context.getResults(results.totalSize());
      outResults.setNode(kj::heap<HidingNode>(results.getNode(), kj::mv(subHides)));
      outResults.setTtl(results.getTtl());
    });
  }

private:
  std::set<kj::StringPtr> hidePaths;
};

class TrackingNode final: public DelegatingNode {
  // A node which tracks what nodes are ultimately opened.

public:
  TrackingNode(fuse::Node::Client delegate, kj::String path,
               kj::Function<void(kj::StringPtr)>& callback)
      : DelegatingNode(delegate), path(kj::mv(path)), callback(callback) {}

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    auto params = context.getParams();
    auto name = params.getName();
    auto subPath = path == nullptr ? kj::heapString(name) : kj::str(path, '/', name);
    auto request = delegate.lookupRequest(params.totalSize());
    request.setName(name);
    context.releaseParams();
    auto& callback = this->callback;
    return request.send().then([context, KJ_MVCAP(subPath), &callback](auto&& response) mutable {
      auto results = context.getResults(capnp::MessageSize {4, 1});
      results.setNode(kj::heap<TrackingNode>(response.getNode(), kj::mv(subPath), callback));
      results.setTtl(response.getTtl());
    });
  }

  kj::Promise<void> openAsFile(OpenAsFileContext context) override {
    markUsed();
    return DelegatingNode::openAsFile(kj::mv(context));
  }

  kj::Promise<void> openAsDirectory(OpenAsDirectoryContext context) override {
    markUsed();
    return DelegatingNode::openAsDirectory(kj::mv(context));
  }

  kj::Promise<void> readlink(ReadlinkContext context) override {
    markUsed();
    return DelegatingNode::readlink(kj::mv(context));
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

class SingletonDirectory final: public SimpleDirecotry {
public:
  explicit SingletonDirectory(kj::StringPtr path): path(path) {}

  kj::Promise<kj::Array<SimpleEntry>> simpleRead() override {
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

class SingletonNode final: public fuse::Node::Server {
  // A directory node which contains only one member mapped at some path.

public:
  SingletonNode(fuse::Node::Client member, kj::StringPtr path)
      : member(kj::mv(member)), path(path) {}

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    auto params = context.getParams();
    auto name = params.getName();

    if (path.startsWith(name)) {
      auto sub = path.slice(name.size());
      if (sub.size() == 0) {
        // This is the exact path.
        auto results = context.getResults(capnp::MessageSize {4, 1});
        results.setNode(member);
        results.setTtl(kj::maxValue);
        return kj::READY_NOW;
      } else if (sub.startsWith("/")) {
        sub = sub.slice(1);
        auto results = context.getResults(capnp::MessageSize {4, 1});
        results.setNode(kj::heap<SingletonNode>(member, sub));
        results.setTtl(kj::maxValue);
        return kj::READY_NOW;
      }
    }

    KJ_FAIL_REQUIRE("no such file or directory");
  }

  kj::Promise<void> getAttributes(GetAttributesContext context) override {
    auto results = context.getResults(capnp::MessageSize {
      capnp::sizeInWords<GetAttributesResults>() +
          capnp::sizeInWords<fuse::Node::Attributes>(),
      0
    });
    results.setTtl(kj::maxValue);

    auto attr = results.initAttributes();
    attr.setInodeNumber(0);
    attr.setType(fuse::Node::Type::DIRECTORY);
    attr.setPermissions(0555);
    attr.setLinkCount(1);

    return kj::READY_NOW;
  }

  kj::Promise<void> openAsFile(OpenAsFileContext context) override {
    KJ_FAIL_REQUIRE("not a file");
  }

  kj::Promise<void> openAsDirectory(OpenAsDirectoryContext context) override {
    auto results = context.getResults(capnp::MessageSize { 4, 1 });
    results.setDirectory(kj::heap<SingletonDirectory>(path));
    return kj::READY_NOW;
  }

  kj::Promise<void> readlink(ReadlinkContext context) override {
    KJ_FAIL_REQUIRE("not a symlink");
  }

private:
  fuse::Node::Client member;
  kj::StringPtr path;
};

class SimpleDataFile final: public fuse::File::Server {
public:
  SimpleDataFile(kj::ArrayPtr<const capnp::word> data)
      : data(kj::arrayPtr(reinterpret_cast<const kj::byte*>(data.begin()),
                          data.size() * sizeof(capnp::word))) {}

protected:
  kj::Promise<void> read(ReadContext context) {
    auto params = context.getParams();
    auto offset = kj::min(data.size(), params.getOffset());
    auto size = kj::min(data.size() - offset, params.getSize());

    auto results = context.getResults(capnp::MessageSize { size / sizeof(capnp::word) + 4, 0 });
    results.setData(data.slice(offset, offset + size));

    return kj::READY_NOW;
  }

private:
  kj::ArrayPtr<const kj::byte> data;
};

class SimpleDataNode final: public fuse::Node::Server {
  // A node wrapping a byte array and exposing it as a file.

public:
  SimpleDataNode(kj::Array<capnp::word> data): data(kj::mv(data)) {}

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    KJ_FAIL_REQUIRE("not a directory");
  }

  kj::Promise<void> getAttributes(GetAttributesContext context) override {
    auto results = context.getResults(capnp::MessageSize {
      capnp::sizeInWords<GetAttributesResults>() +
          capnp::sizeInWords<fuse::Node::Attributes>(),
      0
    });
    results.setTtl(kj::maxValue);

    auto attr = results.initAttributes();
    attr.setInodeNumber(0);
    attr.setType(fuse::Node::Type::REGULAR);
    attr.setPermissions(0444);
    attr.setLinkCount(1);
    attr.setSize(data.size() * sizeof(capnp::word));

    return kj::READY_NOW;
  }

  kj::Promise<void> openAsFile(OpenAsFileContext context) override {
    auto results = context.getResults(capnp::MessageSize { 4, 1 });
    results.setFile(kj::heap<SimpleDataFile>(data));
    return kj::READY_NOW;
  }

  kj::Promise<void> openAsDirectory(OpenAsDirectoryContext context) override {
    KJ_FAIL_REQUIRE("not a directory");
  }

  kj::Promise<void> readlink(ReadlinkContext context) override {
    KJ_FAIL_REQUIRE("not a symlink");
  }

private:
  kj::Array<capnp::word> data;
};

}  // namespace

fuse::Node::Client makeUnionFs(kj::StringPtr sourceDir, spk::SourceMap::Reader sourceMap,
                               spk::Manifest::Reader manifest,
                               kj::Function<void(kj::StringPtr)>& callback) {
  auto searchPath = sourceMap.getSearchPath();
  auto layers = kj::heapArrayBuilder<fuse::Node::Client>(searchPath.size() + 1);

  {
    capnp::MallocMessageBuilder manifestCopy(manifest.totalSize().wordCount + 4);
    manifestCopy.setRoot(manifest);
    layers.add(kj::heap<SingletonNode>(kj::heap<SimpleDataNode>(
        capnp::messageToFlatArray(manifestCopy)), "sandstorm-manifest"));
  }

  for (auto mapping: searchPath) {
    kj::StringPtr sourcePath = mapping.getSourcePath();
    kj::String ownSourcePath;

    // Interpret relative paths against the source dir (if it's not the current directory).
    if (sourceDir.size() != 0 && !sourcePath.startsWith("/")) {
      ownSourcePath = kj::str(sourceDir, '/', sourcePath);
      sourcePath = ownSourcePath;
    }

    // Create the filesystem node.
    // We set a low TTL here, but note that the spk tool overrides it anyway.
    fuse::Node::Client node = newLoopbackFuseNode(sourcePath, 1 * kj::SECONDS);

    // If any contents are hidden, wrap in a hiding node.
    auto hides = mapping.getHidePaths();
    if (hides.size() > 0) {
      std::set<kj::StringPtr> hideSet;
      for (auto hide: hides) {
        hideSet.insert(hide);
      }
      node = kj::heap<HidingNode>(kj::mv(node), kj::mv(hideSet));
    }

    // If the contents are mapped to a non-root location, wrap in a singleton node.
    kj::StringPtr packagePath = mapping.getPackagePath();
    KJ_ASSERT(!packagePath.startsWith("/"),
              "`packagePath` in source map should not start with '/'.");
    if (packagePath.size() > 0) {
      node = kj::heap<SingletonNode>(kj::mv(node), packagePath);
    }

    layers.add(kj::mv(node));
  }

  auto merged = kj::heap<UnionNode>(layers.finish());
  return kj::heap<TrackingNode>(kj::mv(merged), nullptr, callback);
}

}  // namespace sandstorm
