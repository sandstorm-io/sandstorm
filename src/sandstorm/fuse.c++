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

#include "fuse.h"
#include "send-fd.h"
#include "util.h"
#include <linux/fuse.h>
#include <kj/debug.h>
#include <kj/one-of.h>
#include <unordered_map>
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <kj/async-unix.h>
#include <sys/uio.h>
#include <kj/io.h>
#include <kj/time.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/sysmacros.h>

namespace sandstorm {

using kj::uint;

class FuseDriver {
public:
  FuseDriver(kj::UnixEventPort& eventPort, int fuseFd, kj::Own<fuse::Node>&& root,
             FuseOptions options)
      : observer(eventPort, fuseFd, kj::UnixEventPort::FdObserver::OBSERVE_READ),
        fuseFd(fuseFd), options(options) {
    nodeMap.insert(std::make_pair(FUSE_ROOT_ID, NodeMapEntry { kj::mv(root), 1 }));

    int flags;
    KJ_SYSCALL(flags = fcntl(fuseFd, F_GETFL));
    if ((flags & O_NONBLOCK) == 0) {
      KJ_SYSCALL(fcntl(fuseFd, F_SETFL, flags | O_NONBLOCK));
    }
  }

  kj::Promise<void> run() {
    auto paf = kj::newPromiseAndFulfiller<void>();
    abortReadLoop = kj::mv(paf.fulfiller);

    // Wait for readLoop() to report disconnect, but fail early if aborted.
    return readLoop().exclusiveJoin(kj::mv(paf.promise));
  }

private:
  kj::UnixEventPort::FdObserver observer;
  int fuseFd;
  FuseOptions options;
  kj::Own<kj::PromiseFulfiller<void>> abortReadLoop;  // Reject this to stop reading early.

  struct NodeMapEntry {
    kj::Own<fuse::Node> node;
    uint refcount = 0;  // number of "lookup" requests that have returned this node

    // TODO(cleanup):  Come up with better map implementation that doesn't freak out about the
    //   non-const copy constructor.
    KJ_DISALLOW_COPY(NodeMapEntry);
    NodeMapEntry(NodeMapEntry&&) = default;
    NodeMapEntry& operator=(NodeMapEntry&&) = default;
  };

  struct FileMapEntry {
    kj::Own<fuse::File> cap;

    // TODO(cleanup):  Come up with better map implementation that doesn't freak out about the
    //   non-const copy constructor.
    KJ_DISALLOW_COPY(FileMapEntry);
    FileMapEntry(FileMapEntry&&) = default;
    FileMapEntry& operator=(FileMapEntry&&) = default;
  };

  struct DirectoryMapEntry {
    kj::Own<fuse::Directory> cap;

    // TODO(cleanup):  Come up with better map implementation that doesn't freak out about the
    //   non-const copy constructor.
    KJ_DISALLOW_COPY(DirectoryMapEntry);
    DirectoryMapEntry(DirectoryMapEntry&&) = default;
    DirectoryMapEntry& operator=(DirectoryMapEntry&&) = default;
  };

  struct ChildKey {
    uint64_t parentId;
    kj::StringPtr name;

    struct Eq {
      inline bool operator()(const ChildKey& a, const ChildKey& b) const {
        return a.parentId == b.parentId && a.name == b.name;
      }
    };
    struct Hash {
      inline size_t operator()(const ChildKey& key) const {
        // TODO(someday): Add hash functions to KJ and use them here.
        uint64_t hash = key.parentId ^ 0xcbf29ce484222325ull;
        for (char c: key.name) {
          hash = hash * 0x100000001b3ull;
          hash ^= c;
        }
        return hash;
      }
    };
  };

  struct ChildInfo {
    uint64_t nodeId;
    uint64_t inode;
    kj::String name;
  };

  std::unordered_map<uint64_t, NodeMapEntry> nodeMap;
  std::unordered_map<ChildKey, ChildInfo, ChildKey::Hash, ChildKey::Eq> childMap;
  uint64_t nodeIdCounter = 1000;

  std::unordered_map<uint64_t, FileMapEntry> fileMap;
  std::unordered_map<uint64_t, DirectoryMapEntry> directoryMap;
  uint64_t handleCounter = 0;

  kj::byte buffer[65536 + 100];

  // =====================================================================================
  // Write helpers

  struct ObjToInsert {
    ObjToInsert(uint64_t id, kj::Own<fuse::Node>&& node): id(id) {
      obj.init<kj::Own<fuse::Node>>(kj::mv(node));
    }

    ObjToInsert(uint64_t id, kj::Own<fuse::File>&& file): id(id) {
      obj.init<kj::Own<fuse::File>>(kj::mv(file));
    }

    ObjToInsert(uint64_t id, kj::Own<fuse::Directory>&& directory): id(id) {
      obj.init<kj::Own<fuse::Directory>>(kj::mv(directory));
    }

    uint64_t id;
    kj::OneOf<kj::Own<fuse::Node>, kj::Own<fuse::File>, kj::Own<fuse::Directory>> obj;

  };

  struct ResponseBase {
    kj::Maybe<ObjToInsert> newObject;
    // If the operation created a new capability, this is it. It hasn't been added to the tables
    // yet; that should happen when the write() completes successfully, in case the operation is
    // canceled (and the promised dropped) before that.

    struct fuse_out_header header;
    // Do not place any other members after `header` -- we rely on the subclass being able to
    // specify another struct contiguously. (Horrible hack but it totally works.)

    inline ResponseBase() { memset(&header, 0, sizeof(header)); }
    virtual ~ResponseBase() noexcept(false) {}

    virtual size_t size() { return sizeof(header); }
    virtual ssize_t writeSelf(int fd) { return write(fd, &header, sizeof(header)); }
  };

  template <typename T>
  struct Response: public ResponseBase {
    T body;
    size_t bodySize;

    inline Response(): bodySize(sizeof(body)) {
      memset(&body, 0, sizeof(body));
    }

    virtual size_t size() override {
      return sizeof(header) + bodySize;
    }

    virtual ssize_t writeSelf(int fd) override {
      KJ_ASSERT(kj::implicitCast<void*>(&header + 1) == kj::implicitCast<void*>(&body));
      return write(fd, &header, sizeof(header) + bodySize);
    }
  };

  template <typename T, typename ContentOwner>
  struct ResponseWithContent: public Response<T> {
    ContentOwner owner;
    kj::ArrayPtr<const kj::byte> content;

    inline explicit ResponseWithContent(ContentOwner&& owner, kj::ArrayPtr<const kj::byte> content)
        : owner(kj::mv(owner)), content(content) {}

    virtual size_t size() override {
      return sizeof(this->header) + sizeof(this->body) + content.size();
    }

    virtual ssize_t writeSelf(int fd) override {
      KJ_ASSERT(kj::implicitCast<void*>(&this->header + 1) == kj::implicitCast<void*>(&this->body));

      struct iovec parts[2];
      parts[0].iov_base = &this->header;
      parts[0].iov_len = sizeof(this->header) + sizeof(this->body);
      parts[1].iov_base = const_cast<kj::byte*>(content.begin());
      parts[1].iov_len = content.size();

      return writev(fd, parts, 2);
    }
  };

  template <typename ContentOwner>
  struct ResponseWithContent<void, ContentOwner>: public ResponseBase {
    ContentOwner owner;
    kj::ArrayPtr<const kj::byte> content;

    inline explicit ResponseWithContent(ContentOwner&& owner, kj::ArrayPtr<const kj::byte> content)
        : owner(kj::mv(owner)), content(content) {}

    virtual size_t size() override {
      return sizeof(this->header) + content.size();
    }

    virtual ssize_t writeSelf(int fd) override {
      struct iovec parts[2];
      parts[0].iov_base = &this->header;
      parts[0].iov_len = sizeof(this->header);
      parts[1].iov_base = const_cast<kj::byte*>(content.begin());
      parts[1].iov_len = content.size();

      return writev(fd, parts, 2);
    }
  };

  template <typename T>
  kj::Own<Response<T>> allocResponse() {
    return kj::heap<Response<T>>();
  }

  kj::Own<ResponseBase> allocEmptyResponse() {
    return kj::heap<ResponseBase>();
  }

  template <typename T, typename ContentOwner>
  kj::Own<ResponseBase> allocResponse(ContentOwner&& owner, kj::ArrayPtr<const kj::byte> content) {
    return kj::heap<ResponseWithContent<T, ContentOwner>>(kj::mv(owner), content);
  }

  template <typename Function>
  void performReplyTask(uint64_t requestId, int defaultError, Function&& task) {
    kj::Maybe<kj::Own<ResponseBase>> maybeResponse;
    auto exception = kj::runCatchingExceptions(
        [&maybeResponse, requestId, KJ_MVCAP(task)]() mutable {
      auto taskResponse = task(); // This is allowed to be an error response.
      taskResponse->header.unique = requestId;
      maybeResponse = kj::mv(taskResponse);
    });

    KJ_IF_MAYBE(e, exception) {
      auto errorResponse = kj::heap<ResponseBase>();
      errorResponse->header.error = -defaultError; // TODO(someday): Real error numbers.
      errorResponse->header.unique = requestId;
      maybeResponse = kj::mv(errorResponse);
    }

    KJ_IF_MAYBE (response, maybeResponse) {
      auto writeException = kj::runCatchingExceptions([KJ_MVCAP(response), this] () {
        writeResponse(kj::mv(*response));
      });

      KJ_IF_MAYBE(e, writeException) {
        // We only get here if the write failed. Abort.
        abortReadLoop->reject(kj::mv(*e));
      }
    }
  }

  void sendReply(uint64_t requestId, kj::Own<ResponseBase>&& response) {
    response->header.unique = requestId;
    writeResponse(kj::mv(response));
  }

  void sendError(uint64_t requestId, int error) {
    auto response = kj::heap<ResponseBase>();
    response->header.error = -error;  // Has to be negative. Just because.
    response->header.unique = requestId;
    writeResponse(kj::mv(response));
  }

  void writeResponse(kj::Own<ResponseBase>&& response) {
    size_t size = response->size();
    response->header.len = size;

  retry:
    ssize_t n = response->writeSelf(fuseFd);

    if (n < 0) {
      int error = errno;
      switch (error) {
        case EINTR:
          goto retry;
        case EAGAIN:
          KJ_FAIL_ASSERT("write(/dev/fuse) returned EAGAIN; I thought this wasn't possible.");
        case ENOENT:
          // According to the libfuse code, this means "the operation was interrupted". It's
          // unclear to me if this is officially part of the protocol or if libfuse is just not
          // doing the proper bookkeeping and is double-replying to interrupted requests. In any
          // case, it seems safe to move on here (without updating the cap maps).
          break;
        default:
          KJ_FAIL_SYSCALL("write(/dev/fuse)", error);
      }
    } else {
      KJ_ASSERT(n == size, "write() to FUSE device didn't accept entire command?");

      // Message accepted. Make sure any new capability is added to the appropriate table.
      KJ_IF_MAYBE(newObj, response->newObject) {
        if (newObj->obj.is<kj::Own<fuse::Node>>()) {
          auto insertResult = nodeMap.insert(std::make_pair(newObj->id,
              NodeMapEntry { newObj->obj.get<kj::Own<fuse::Node>>()->addRef(), 0 }));
          ++insertResult.first->second.refcount;
        } else if (newObj->obj.is<kj::Own<fuse::File>>()) {
          fileMap.insert(std::make_pair(newObj->id,
              FileMapEntry { newObj->obj.get<kj::Own<fuse::File>>()->addRef() }));
        } else if (newObj->obj.is<kj::Own<fuse::Directory>>()) {
          directoryMap.insert(std::make_pair(newObj->id,
              DirectoryMapEntry { newObj->obj.get<kj::Own<fuse::Directory>>()->addRef() }));
        }
      }
    }
  }

  // =====================================================================================
  // Read loop

  kj::Promise<void> readLoop() {
    for (;;) {
      ssize_t bytesRead = read(fuseFd, buffer, sizeof(buffer));

      if (bytesRead < 0) {
        int error = errno;
        switch (errno) {
          case EINTR:
            continue;
          case ENOENT:
            // libfuse simply retries on ENOENT. Comment says that ENOENT means "the operation
            // was interrupted", but I can't tell what that's supposed to mean. It makes sense
            // for write() but what operation is being interrupted on read()? Well, anyway, we do
            // what libfuse does and retry in this case.
            continue;
          case EAGAIN:
            // No data to read.  Try again later.
            return observer.whenBecomesReadable().then([this]() { return readLoop(); });
          case ENODEV:
            // Unmounted.
            return kj::READY_NOW;
          default:
            KJ_FAIL_SYSCALL("read(/dev/fuse)", error);
        }
        KJ_UNREACHABLE;
      }

      // OK, we got some bytes.
      auto bufferPtr = kj::arrayPtr(buffer, bytesRead);

      while (bufferPtr.size() > 0) {
        struct fuse_in_header header;
        KJ_ASSERT(bufferPtr.size() >= sizeof(header), "Incomplete FUSE header from kernel?");
        memcpy(&header, bufferPtr.begin(), sizeof(header));
        KJ_ASSERT(bufferPtr.size() >= header.len, "Incomplete FUSE message from kernel?");
        if (!dispatch(header, bufferPtr.slice(sizeof(header), header.len))) {
          // Got FUSE_DESTROY.
          return kj::READY_NOW;
        }
        bufferPtr = bufferPtr.slice(header.len, bufferPtr.size());
      }
    }
  }

  bool dispatch(struct fuse_in_header& header, kj::ArrayPtr<const kj::byte> body) {
    auto nodeIter = nodeMap.find(header.nodeid);
    KJ_REQUIRE(header.nodeid == 0 || nodeIter != nodeMap.end(),
        "Kernel asked for unknown node ID.", header.nodeid);

    switch (header.opcode) {
      case FUSE_INIT: {
        auto initBody = consumeStruct<struct fuse_init_in>(body);
        KJ_REQUIRE(initBody.major == 7);
        KJ_REQUIRE(initBody.minor >= 20);

        auto reply = allocResponse<struct fuse_init_out>();
        reply->body.major = 7;
        reply->body.minor = 20;
        reply->body.max_readahead = 65536;
        reply->body.max_write = 65536;

#ifdef FUSE_COMPAT_22_INIT_OUT_SIZE
        // Compatibility with pre-2.15 kernels.
        reply->bodySize = FUSE_COMPAT_22_INIT_OUT_SIZE;
#endif

        sendReply(header.unique, kj::mv(reply));
        break;
      }

      case FUSE_DESTROY:
        return false;

      case FUSE_FORGET: {
        auto requestBody = consumeStruct<struct fuse_forget_in>(body);
        if ((nodeIter->second.refcount -= requestBody.nlookup) == 0) {
          nodeMap.erase(nodeIter);
        }
        break;
      }

      case FUSE_BATCH_FORGET: {
        auto requestBody = consumeStruct<struct fuse_batch_forget_in>(body);

        for (uint i = 0; i < requestBody.count; i++) {
          auto item = consumeStruct<struct fuse_forget_one>(body);
          auto iter2 = nodeMap.find(item.nodeid);
          KJ_REQUIRE(iter2 != nodeMap.end());
          if ((iter2->second.refcount -= item.nlookup) == 0) {
            nodeMap.erase(iter2);
          }
        }
        break;
      }

      case FUSE_LOOKUP: {
        auto name = consumeString(body);
        auto requestId = header.unique;
        uint64_t parentId = header.nodeid;
        kj::String ownName = kj::heapString(name);

        performReplyTask(requestId, EIO,
            [this, parentId, nodeIter, KJ_MVCAP(ownName)]() mutable -> kj::Own<ResponseBase> {
          auto maybeLookupResult = nodeIter->second.node->lookup(ownName.slice(0));
          KJ_IF_MAYBE(lookupResult, maybeLookupResult) {
            auto result = lookupResult->node->getAttributes();
            auto attributes = result.attributes;

            auto reply = allocResponse<struct fuse_entry_out>();

            uint64_t inode = attributes.inodeNumber;
            auto insertResult = childMap.insert(std::make_pair(
                ChildKey { parentId, ownName }, ChildInfo()));

            // Make sure the StringPtr in the key points at the String in the value.
            if (insertResult.second) {
              // This is a newly-inserted entry.
              insertResult.first->second.name = kj::mv(ownName);
            } else {
              // Existing entry. Check consistency.
              KJ_ASSERT(insertResult.first->second.name.begin() ==
                        insertResult.first->first.name.begin());
            }

            if (insertResult.second || insertResult.first->second.inode != inode) {
              // Either we've never looked up this child before, or the inode number has changed
              // since we looked it up so we assume it has been replaced by a new node.
              //
              // TODO(someday): It would be better to detect when a node has been replaced by
              //   comparing the capabilities, though this requires "join" support (level 4 RPC).
              reply->body.nodeid = nodeIdCounter++;
              insertResult.first->second.nodeId = reply->body.nodeid;
              insertResult.first->second.inode = inode;
            } else {
              // This appears to be exactly the same child we returned previously. Use the same
              // node ID.
              reply->body.nodeid = insertResult.first->second.nodeId;
            }

            reply->body.generation = 0;
            reply->newObject = ObjToInsert(reply->body.nodeid, kj::mv(lookupResult->node));

            translateAttrs(attributes, &reply->body.attr);
            if (options.cacheForever) {
              reply->body.entry_valid = 365 * kj::DAYS / kj::SECONDS;
              reply->body.attr_valid = 365 * kj::DAYS / kj::SECONDS;
            } else {
              splitTime(lookupResult->ttl,
                  &reply->body.entry_valid, &reply->body.entry_valid_nsec);
              splitTime(result.ttl,
                  &reply->body.attr_valid, &reply->body.attr_valid_nsec);
            }
            return kj::mv(reply);
          } else {
            auto reply = kj::heap<ResponseBase>();
            reply->header.error = -ENOENT;  // Has to be negative. Just because.
            return kj::mv(reply);
          }
        });
        break;
      }

      case FUSE_GETATTR: {
        performReplyTask(header.unique, EIO, [this, nodeIter]() -> kj::Own<ResponseBase> {
          auto response = nodeIter->second.node->getAttributes();

          auto reply = allocResponse<struct fuse_attr_out>();
          if (options.cacheForever) {
            reply->body.attr_valid = 365 * kj::DAYS / kj::SECONDS;
          } else {
            splitTime(response.ttl, &reply->body.attr_valid, &reply->body.attr_valid_nsec);
          }
          translateAttrs(response.attributes, &reply->body.attr);
          return kj::mv(reply);
        });
        break;
      }

      case FUSE_READLINK:
        // No input.
        performReplyTask(header.unique, EINVAL, [this, nodeIter]() -> kj::Own<ResponseBase> {
          auto link = nodeIter->second.node->readlink();
          auto bytes = kj::arrayPtr(reinterpret_cast<const kj::byte*>(link.begin()), link.size());
          return allocResponse<void>(kj::mv(link), bytes);
        });
        break;

      case FUSE_OPEN: {
        auto request = consumeStruct<struct fuse_open_in>(body);

        if ((request.flags & O_ACCMODE) != O_RDONLY) {
          sendError(header.unique, EROFS);
          break;
        }

        // TODO(perf): Can we assume the kernel will check permissions before open()? If so,
        //   perhaps we ought to assume this should always succeed and thus pipeline it?
        performReplyTask(header.unique, EIO, [this, nodeIter]() -> kj::Own<ResponseBase> {
          auto response = nodeIter->second.node->openAsFile();
          KJ_IF_MAYBE(file, response) {
            auto reply = allocResponse<struct fuse_open_out>();
            reply->body.fh = handleCounter++;
            reply->newObject = ObjToInsert(reply->body.fh, kj::mv(*file));

            // TODO(someday):  Fill in open_flags, especially "nonseekable"?  See FOPEN_* in fuse.h.
            if (options.cacheForever) reply->body.open_flags |= FOPEN_KEEP_CACHE;
            return kj::mv(reply);
          } else {
            KJ_FAIL_REQUIRE("not a file");
          }
        });
        break;
      }

      case FUSE_READ: {
        auto request = consumeStruct<struct fuse_read_in>(body);

        auto iter2 = fileMap.find(request.fh);
        KJ_REQUIRE(iter2 != fileMap.end(), "Kernel requested invalid file handle?");

        performReplyTask(header.unique, EIO,
            [this, KJ_MVCAP(request), iter2]() -> kj::Own<ResponseBase> {
          auto bytes = iter2->second.cap->read(request.offset, request.size);
          kj::ArrayPtr<kj::byte> slice = bytes.asPtr();
          return allocResponse<void>(kj::mv(bytes), slice);
        });
        break;
      }

      case FUSE_RELEASE: {
        // TODO(someday): When we support writes, we'll need to flush them here and possibly return
        //   an error.
        auto request = consumeStruct<struct fuse_release_in>(body);
        KJ_REQUIRE(fileMap.erase(request.fh) == 1, "Kernel released invalid file handle?");
        sendReply(header.unique, allocEmptyResponse());
        break;
      }

      case FUSE_OPENDIR: {
        auto request = consumeStruct<struct fuse_open_in>(body);

        if ((request.flags & O_ACCMODE) != O_RDONLY) {
          sendError(header.unique, EROFS);
          break;
        }

        // TODO(perf): Can we assume the kernel will check permissions before open()? If so,
        //   perhaps we ought to assume this should always succeed and thus pipeline it?
        performReplyTask(header.unique, EIO, [this, nodeIter]() -> kj::Own<ResponseBase> {
          auto maybeDirectory = nodeIter->second.node->openAsDirectory();
          KJ_IF_MAYBE(directory, maybeDirectory) {
            auto reply = allocResponse<struct fuse_open_out>();
            reply->body.fh = handleCounter++;
            reply->newObject = ObjToInsert(reply->body.fh, kj::mv(*directory));
            return kj::mv(reply);
          } else {
            KJ_FAIL_REQUIRE("not a directory");
          }
        });
        break;
      }

      case FUSE_READDIR: {
        auto request = consumeStruct<struct fuse_read_in>(body);

        auto iter2 = directoryMap.find(request.fh);
        KJ_REQUIRE(iter2 != directoryMap.end(), "Kernel requested invalid directory handle?");

        // Annoyingly, request.size is actually a size, in bytes. How many entries fit into that
        // size is dependent on the entry names as well as the size of fuse_dirent. It would be
        // annoying for implementations to have to compute this, so instead we make an estimate
        // based on the assumption that the average file name is between 8 and 16 characters.  If
        // file names turn out to be shorter, this may mean we produce a short read, but that
        // appears to be OK -- the kernel will only assume EOF if the result is completely empty.
        // If file names turn out to be longer, we may end up truncating the resulting list and
        // then re-requesting it.  Someday we could implement some sort of streaming here to fix
        // this, but that will be pretty ugly and it probably doesn't actually matter that much.

        auto requestedSize = request.size;
        auto requestedOffset = request.offset;

        performReplyTask(header.unique, EIO,
            [this, requestedSize, requestedOffset, iter2]() -> kj::Own<ResponseBase> {
          auto entries = iter2->second.cap->read(
              requestedOffset,
              requestedSize / (sizeof(struct fuse_dirent) + 16));

          size_t totalBytes = 0;
          for (auto& entry: entries) {
            // Carefully check whether we'll go over the requested size if we add this entry.  If
            // so, break now.
            size_t next = totalBytes + FUSE_DIRENT_ALIGN(FUSE_NAME_OFFSET + entry.name.size());
            if (next > requestedSize) {
              break;
            }
            totalBytes = next;
          }

          auto bytes = kj::heapArray<kj::byte>(totalBytes);
          kj::byte* pos = bytes.begin();
          memset(pos, 0, bytes.size());

          for (auto& entry: entries) {
            auto& dirent = *reinterpret_cast<struct fuse_dirent*>(pos);
            auto& name = entry.name;

            dirent.ino = entry.inodeNumber;
            dirent.off = entry.nextOffset;
            dirent.namelen = name.size();
            dirent.type = DT_UNKNOWN;
            switch (entry.type) {
              case fuse::Node::Type::UNKNOWN:                                 break;
              case fuse::Node::Type::BLOCK_DEVICE:     dirent.type = DT_BLK ; break;
              case fuse::Node::Type::CHARACTER_DEVICE: dirent.type = DT_CHR ; break;
              case fuse::Node::Type::DIRECTORY:        dirent.type = DT_DIR ; break;
              case fuse::Node::Type::FIFO:             dirent.type = DT_FIFO; break;
              case fuse::Node::Type::SYMLINK:          dirent.type = DT_LNK ; break;
              case fuse::Node::Type::REGULAR:          dirent.type = DT_REG ; break;
              case fuse::Node::Type::SOCKET:           dirent.type = DT_SOCK; break;
            }

            memcpy(dirent.name, name.begin(), name.size());
            pos += FUSE_DIRENT_ALIGN(FUSE_NAME_OFFSET + name.size());

            // Check if we truncated the list.
            if (pos == bytes.end()) {
              break;
            }
          }

          KJ_ASSERT(pos == bytes.end());

          auto bytesPtr = bytes.asPtr();  // Don't inline; param construction order is undefined.
          return allocResponse<void>(kj::mv(bytes), bytesPtr);
        });
        break;
      }

      case FUSE_RELEASEDIR: {
        // Presumably since directories aren't writable there's no possibility of close() errors.
        auto request = consumeStruct<struct fuse_release_in>(body);
        KJ_REQUIRE(directoryMap.erase(request.fh) == 1,
                   "Kernel released invalid directory handle?");
        sendReply(header.unique, allocEmptyResponse());
        break;
      }

      case FUSE_ACCESS: {
        // If the node exists then F_OK and R_OK are implied. W_OK
        auto request = consumeStruct<struct fuse_access_in>(body);

        auto mask = request.mask;

        if (request.mask & ~(R_OK | X_OK | F_OK)) {
          // Some bit other than read/execute is being checked (presumably, W_OK). This is a
          // read-only filesystem.
          sendError(header.unique, EROFS);
        } else if (request.mask != 0) {
          // Need to check permissions.
          performReplyTask(header.unique, EACCES,
              [this, nodeIter, mask]() -> kj::Own<ResponseBase> {
            auto result = nodeIter->second.node->getAttributes();
            auto attributes = result.attributes;
            // TODO(someday):  Account for uid/gid?  Currently irrelevant.
            if (mask & R_OK) {
              KJ_REQUIRE(attributes.permissions & S_IROTH);
            }
            if (mask & X_OK) {
              KJ_REQUIRE(attributes.permissions & S_IXOTH);
            }

            return allocEmptyResponse();
          });
        } else {
          sendReply(header.unique, allocEmptyResponse());
        }

        break;
      }

      case FUSE_INTERRUPT: {
        // We deal with tasks sequentially, so whatever task this call was intended to interrupt
        // has in fact already completed. Therefore there's nothing for us to do.
        break;
      }

      case FUSE_FLUSH:
        // This seems to be called on close() even for files opened read-only.
        sendReply(header.unique, allocEmptyResponse());
        break;

        // TODO(someday): Missing read-only syscalls: statfs, getxaddr, listxaddr, locking,
        //     readdirplus (we currently set protocol version to pre-readdirplus to avoid it)
        // TODO(someday): Write calls.

      // Write operations:
      case FUSE_BMAP:
      case FUSE_CREATE:
      case FUSE_FSYNC:
      case FUSE_FSYNCDIR:
      case FUSE_LINK:
      case FUSE_MKDIR:
      case FUSE_MKNOD:
      case FUSE_REMOVEXATTR:
      case FUSE_RENAME:
      case FUSE_RMDIR:
      case FUSE_SETATTR:
      case FUSE_SETXATTR:
      case FUSE_SYMLINK:
      case FUSE_UNLINK:
      case FUSE_WRITE:
        sendError(header.unique, EROFS);
        break;

      default:
        // Something we don't implement.
        sendError(header.unique, ENOSYS);
        break;
    }

    return true;
  }

  // =====================================================================================
  // helpers

  template <typename T>
  T consumeStruct(kj::ArrayPtr<const kj::byte>& bytes) {
    T result;
    KJ_REQUIRE(bytes.size() >= sizeof(result));
    memcpy(&result, bytes.begin(), sizeof(result));
    bytes = bytes.slice(sizeof(result), bytes.size());
    return result;
  }

  kj::StringPtr consumeString(kj::ArrayPtr<const kj::byte>& bytes) {
    const char* ptr = reinterpret_cast<const char*>(bytes.begin());
    size_t len = strnlen(ptr, bytes.size());
    KJ_REQUIRE(len < bytes.size());
    bytes = bytes.slice(len + 1, bytes.size());
    return kj::StringPtr(ptr, len);
  }

  void splitTime(uint64_t time, uint64_t* secs, uint32_t* nsecs) {
    *secs = time / 1000000000llu;
    *nsecs = time % 1000000000llu;
  }

  void splitTime(int64_t time, uint64_t* secs, uint32_t* nsecs) {
    // The FUSE interface appears to use unsigned values even for absolute times, implying it
    // cannot represent times before 1970.  I'm going to go ahead and assume that they just
    // declared the types wrong and the kernel will actually interpret them as signed.

    int32_t signedNsec = time % 1000000000ll;
    time = time / 1000000000ll;
    if (signedNsec < 0) {
      ++time;
      signedNsec += 1000000000ll;
    }

    *secs = time;
    *nsecs = signedNsec;
  }

  void translateAttrs(fuse::Node::Attributes& src, struct fuse_attr* dst) {
    memset(dst, 0, sizeof(*dst));

    dst->ino = src.inodeNumber;
    dst->size = src.size;
    dst->blocks = src.blockCount;

    splitTime(src.lastAccessTime, &dst->atime, &dst->atimensec);
    splitTime(src.lastModificationTime, &dst->mtime, &dst->mtimensec);
    splitTime(src.lastStatusChangeTime, &dst->ctime, &dst->ctimensec);

    dst->mode = src.permissions;

    switch (src.type) {
      case fuse::Node::Type::UNKNOWN:                                break;
      case fuse::Node::Type::BLOCK_DEVICE:     dst->mode |= S_IFBLK; break;
      case fuse::Node::Type::CHARACTER_DEVICE: dst->mode |= S_IFCHR; break;
      case fuse::Node::Type::DIRECTORY:        dst->mode |= S_IFDIR; break;
      case fuse::Node::Type::FIFO:             dst->mode |= S_IFIFO; break;
      case fuse::Node::Type::SYMLINK:          dst->mode |= S_IFLNK; break;
      case fuse::Node::Type::REGULAR:          dst->mode |= S_IFREG; break;
      case fuse::Node::Type::SOCKET:           dst->mode |= S_IFSOCK; break;
    }

    dst->nlink = src.linkCount;
    dst->uid = src.ownerId;
    dst->gid = src.groupId;
    dst->rdev = makedev(src.deviceMajor, src.deviceMinor);
    dst->blksize = src.blockSize;
  }
};

kj::Promise<void> bindFuse(kj::UnixEventPort& eventPort, int fuseFd, kj::Own<fuse::Node> root,
                           FuseOptions options) {
  auto driver = kj::heap<FuseDriver>(eventPort, fuseFd, kj::mv(root), options);
  FuseDriver* driverPtr = driver.get();
  return driverPtr->run().attach(kj::mv(driver));
}

// =======================================================================================

namespace {

inline int64_t toNanos(const struct timespec& ts) {
  return ts.tv_sec * 1000000000ll + ts.tv_nsec;
}

class FileImpl final: public fuse::File, public kj::Refcounted {
public:
  explicit FileImpl(kj::StringPtr path) {
    int ifd;
    KJ_SYSCALL(ifd = open(path.cStr(), O_RDONLY), path);
    fd = kj::AutoCloseFd(ifd);
  }

  kj::Own<fuse::File> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Array<uint8_t> read(uint64_t offset, uint32_t size) override {
    KJ_REQUIRE(size < (1 << 22), "read too large", size);

    auto result = kj::heapArray<uint8_t>(size);

    kj::byte* ptr = result.begin();

    while (size > 0) {
      ssize_t n;
      KJ_SYSCALL(n = pread(fd, ptr, size, offset));
      if (n == 0) {
        break;
      }
      ptr += n;
      offset += n;
      size -= n;
    }

    if (size > 0) {
      // Oops, we hit EOF before filling the buffer. Truncate.
      return kj::heapArray<uint8_t>(result.slice(0, result.size() - size));
    } else {
      return result;
    }
  }

private:
  kj::AutoCloseFd fd;
};

class DirectoryImpl final: public fuse::Directory, public kj::Refcounted {
public:
  DirectoryImpl(kj::StringPtr path) {
    dir = opendir(path.cStr());
    if (dir == nullptr) {
      int error = errno;
      KJ_FAIL_SYSCALL("opendir()", error, path);
    }
  }

  ~DirectoryImpl() {
    closedir(dir);
  }

  kj::Own<fuse::Directory> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Array<Entry> read(uint64_t offset, uint32_t requestedCount) override {
    if (offset != currentOffset) {
      seekdir(dir, offset);
      currentOffset = offset;
    }

    KJ_REQUIRE(requestedCount < 8192, "readdir too large", requestedCount);

    kj::Vector<struct dirent> entries(requestedCount);

    uint count = 0;
    for (; count < requestedCount; count++) {
      struct dirent* ent = readdir(dir);
      if (ent == nullptr) {
        // End of directory.
        break;
      }

      currentOffset = ent->d_off;

      entries.add(*ent);
    }

    auto result = kj::heapArray<Entry>(count);

    for (size_t i: kj::indices(entries)) {
      auto& entry = entries[i];

      result[i].inodeNumber = entry.d_ino;
      result[i].nextOffset = entry.d_off;

      switch (entry.d_type) {
        case DT_BLK:  result[i].type = fuse::Node::Type::BLOCK_DEVICE; break;
        case DT_CHR:  result[i].type = fuse::Node::Type::CHARACTER_DEVICE; break;
        case DT_DIR:  result[i].type = fuse::Node::Type::DIRECTORY; break;
        case DT_FIFO: result[i].type = fuse::Node::Type::FIFO; break;
        case DT_LNK:  result[i].type = fuse::Node::Type::SYMLINK; break;
        case DT_REG:  result[i].type = fuse::Node::Type::REGULAR; break;
        case DT_SOCK: result[i].type = fuse::Node::Type::SOCKET; break;
        default:      result[i].type = fuse::Node::Type::UNKNOWN; break;
      }

      result[i].name = kj::str(entry.d_name);
    }

    return kj::mv(result);
  }

private:
  DIR* dir;
  size_t currentOffset;
};

class NodeImpl final: public fuse::Node, public kj::Refcounted {
public:
  NodeImpl(kj::StringPtr path, kj::Duration ttl)
    : path(kj::heapString(path)), ttl(ttl) { }

  kj::Own<fuse::Node> addRef() override {
    return kj::addRef(*this);
  }

protected:
  kj::Maybe<LookupResults> lookup(kj::StringPtr name) override {
    KJ_REQUIRE(name != "." && name != "..", "Please implement . and .. at a higher level.");

    auto fullPath = kj::str(path, '/', name);
    struct stat new_stats;
    auto n = lstat(fullPath.cStr(), &new_stats);

    if (n < 0 && errno == ENOENT) {
      return nullptr;
    } else {
      uint64_t xttl = ttl / kj::NANOSECONDS;

      return LookupResults { kj::refcounted<NodeImpl>(kj::mv(fullPath), ttl), xttl };
    }
  }

  GetAttributesResults getAttributes() override {
    updateStats();

    auto results = GetAttributesResults { };
    auto& attrs = results.attributes;
    attrs.inodeNumber = stats.st_ino;

    switch (stats.st_mode & S_IFMT) {
      case S_IFBLK:  attrs.type = fuse::Node::Type::BLOCK_DEVICE; break;
      case S_IFCHR:  attrs.type = fuse::Node::Type::CHARACTER_DEVICE; break;
      case S_IFDIR:  attrs.type = fuse::Node::Type::DIRECTORY; break;
      case S_IFIFO:  attrs.type = fuse::Node::Type::FIFO; break;
      case S_IFLNK:  attrs.type = fuse::Node::Type::SYMLINK; break;
      case S_IFREG:  attrs.type = fuse::Node::Type::REGULAR; break;
      case S_IFSOCK: attrs.type = fuse::Node::Type::SOCKET; break;
      default:       attrs.type = fuse::Node::Type::UNKNOWN; break;
    }

    attrs.permissions = stats.st_mode & ~S_IFMT;
    attrs.linkCount = stats.st_nlink;
    attrs.ownerId = stats.st_uid;
    attrs.groupId = stats.st_gid;
    attrs.deviceMajor = major(stats.st_rdev);
    attrs.deviceMinor = minor(stats.st_rdev);
    attrs.size = stats.st_size;
    attrs.blockCount = stats.st_blocks;
    attrs.blockSize = stats.st_blksize;
    attrs.lastAccessTime = toNanos(stats.st_atim);
    attrs.lastModificationTime = toNanos(stats.st_mtim);
    attrs.lastStatusChangeTime = toNanos(stats.st_ctim);
    results.ttl = ttl / kj::NANOSECONDS;

    return kj::mv(results);
  }

  kj::Maybe<kj::Own<fuse::File>> openAsFile() override {
    kj::Own<fuse::File> result =  kj::refcounted<FileImpl>(path);
    return kj::mv(result);
  }

  kj::Maybe<kj::Own<fuse::Directory>> openAsDirectory() override {
    kj::Own<fuse::Directory> result = kj::refcounted<DirectoryImpl>(path);
    return kj::mv(result);
  }

  kj::String readlink() override {
    char buffer[PATH_MAX + 1];
    int n;
    KJ_SYSCALL(n = ::readlink(path.cStr(), buffer, PATH_MAX));
    buffer[n] = '\0';
    return kj::heapString(buffer);
  }

private:
  kj::String path;
  kj::Duration ttl;
  struct stat stats;
  int64_t statsExpirationTime = 0;

  void updateStats() {
    struct timespec ts;
    KJ_SYSCALL(clock_gettime(CLOCK_MONOTONIC, &ts));
    uint64_t time = toNanos(ts);
    if (time >= statsExpirationTime) {
      statsExpirationTime = time + ttl / kj::NANOSECONDS;
      KJ_SYSCALL(lstat(path.cStr(), &stats), path);
    }
  }
};

}  // namespace

kj::Own<fuse::Node> newLoopbackFuseNode(kj::StringPtr path, kj::Duration cacheTtl) {
  return kj::refcounted<NodeImpl>(path, cacheTtl);
}

// =======================================================================================

FuseMount::FuseMount(kj::StringPtr path, kj::StringPtr options): path(kj::heapString(path)) {
  int sockets[2];
  KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets));

  kj::AutoCloseFd clientEnd(sockets[0]);
  kj::AutoCloseFd serverEnd(sockets[1]);

  pid_t pid = fork();
  if (pid == 0) {
    clientEnd = nullptr;

    // KJ likes to adjust the signal mask.  Fix it.
    sigset_t emptySet;
    KJ_SYSCALL(sigemptyset(&emptySet));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &emptySet, nullptr));

    // Set Unix socket FD over which FUSE device FD should be returned.
    KJ_SYSCALL(setenv("_FUSE_COMMFD", kj::str((int)serverEnd).cStr(), true));

    if (options.size() > 0) {
      KJ_SYSCALL(execlp("fusermount", "fusermount", "-o", options.cStr(), "--", path.cStr(),
                        (char*)nullptr));
    } else {
      KJ_SYSCALL(execlp("fusermount", "fusermount", "--", path.cStr(), (char*)nullptr));
    }

    KJ_UNREACHABLE;
  } else {
    serverEnd = nullptr;
    int childStatus;

    {
      KJ_DEFER(KJ_SYSCALL(waitpid(pid, &childStatus, 0)) {break;});
      fd = receiveFd(clientEnd);
    }

    KJ_ASSERT(WIFEXITED(childStatus) && WEXITSTATUS(childStatus) == 0, "fusermount failed");
  }
}

FuseMount::~FuseMount() noexcept(false) {
  if (path == nullptr) return;

  pid_t pid = fork();
  if (pid == 0) {
    // KJ likes to adjust the signal mask.  Fix it.
    sigset_t emptySet;
    KJ_SYSCALL(sigemptyset(&emptySet));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &emptySet, nullptr));

    KJ_SYSCALL(execlp("fusermount", "fusermount", "-u", "--", path.cStr(),
                      (char*)nullptr));

    KJ_UNREACHABLE;
  } else {
    int status;
    KJ_SYSCALL(waitpid(pid, &status, 0)) { return; }
    KJ_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0, "fusermount failed") {
      return;
    }
  }
}

}  // namespace sandstorm
