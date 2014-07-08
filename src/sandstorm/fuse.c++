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

// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.

#include "fuse.h"
#include "send-fd.h"
#include <linux/fuse.h>
#include <kj/debug.h>
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

namespace sandstorm {

#if __QTCREATOR
#define KJ_MVCAP(var) var
// QtCreator dosen't understand C++14 syntax yet.
#else
#define KJ_MVCAP(var) var = ::kj::mv(var)
// Capture the given variable by move.  Place this in a lambda capture list.  Requires C++14.
//
// TODO(cleanup):  Move to libkj.
#endif

using kj::uint;

class FuseDriver final: private kj::TaskSet::ErrorHandler {
public:
  FuseDriver(kj::UnixEventPort& eventPort, int fuseFd, fuse::Node::Client&& root,
             FuseOptions options)
      : eventPort(eventPort), fuseFd(kj::mv(fuseFd)), options(options) {
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
  kj::UnixEventPort& eventPort;
  int fuseFd;
  FuseOptions options;
  std::unordered_map<uint64_t, kj::Promise<void>> tasks;
  kj::Own<kj::PromiseFulfiller<void>> abortReadLoop;  // Reject this to stop reading early.

  kj::Promise<void> lastCompletedTask = nullptr;
  // Hack: A task usually removes itself from `tasks`, but deleting the promise on whose behalf
  //   you are currently running is bad, so it is moved to this member instead, where we know it
  //   won't be overwritten at least until after returning.

  struct NodeMapEntry {
    fuse::Node::Client node;
    uint refcount = 0;  // number of "lookup" requests that have returned this node

    // TODO(cleanup):  Come up with better map implementation that doesn't freak out about the
    //   non-const copy constructor.
    KJ_DISALLOW_COPY(NodeMapEntry);
    NodeMapEntry(NodeMapEntry&&) = default;
    NodeMapEntry& operator=(NodeMapEntry&&) = default;
  };

  struct FileMapEntry {
    fuse::File::Client cap;

    // TODO(cleanup):  Come up with better map implementation that doesn't freak out about the
    //   non-const copy constructor.
    KJ_DISALLOW_COPY(FileMapEntry);
    FileMapEntry(FileMapEntry&&) = default;
    FileMapEntry& operator=(FileMapEntry&&) = default;
  };

  struct DirectoryMapEntry {
    fuse::Directory::Client cap;

    // TODO(cleanup):  Come up with better map implementation that doesn't freak out about the
    //   non-const copy constructor.
    KJ_DISALLOW_COPY(DirectoryMapEntry);
    DirectoryMapEntry(DirectoryMapEntry&&) = default;
    DirectoryMapEntry& operator=(DirectoryMapEntry&&) = default;
  };

  std::unordered_map<uint64_t, NodeMapEntry> nodeMap;
  uint64_t nodeIdCounter = 1000;

  std::unordered_map<uint64_t, FileMapEntry> fileMap;
  std::unordered_map<uint64_t, DirectoryMapEntry> directoryMap;
  uint64_t handleCounter = 0;

  kj::byte buffer[65536 + 100];

  // =====================================================================================

  void taskFailed(kj::Exception&& exception) override {
    abortReadLoop->reject(kj::mv(exception));
  }

  void completeTask(uint64_t requestId) {
    // Remove the task with the given ID from the task map, but don't delete it because we may
    // be acting on behalf of that task right now.

    auto iter = tasks.find(requestId);
    KJ_ASSERT(iter != tasks.end());
    lastCompletedTask = kj::mv(iter->second);
    tasks.erase(iter);
  }

  // =====================================================================================
  // Write helpers

  enum class IdType { NODE, FILE, DIRECTORY };

  struct CapToInsert {
    IdType idType;
    uint64_t id;
    capnp::Capability::Client cap;
  };

  struct ResponseBase {
    kj::Maybe<CapToInsert> newObject;
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

    inline Response() {
      memset(&body, 0, sizeof(body));
    }

    virtual size_t size() override {
      return sizeof(header) + sizeof(body);
    }

    virtual ssize_t writeSelf(int fd) override {
      KJ_ASSERT(kj::implicitCast<void*>(&header + 1) == kj::implicitCast<void*>(&body));
      return write(fd, &header, sizeof(header) + sizeof(body));
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

  void addReplyTask(uint64_t requestId, int defaultError,
                    kj::Promise<kj::Own<ResponseBase>>&& task) {
    auto promise = task.then([this, requestId](auto&& response) {
      response->header.error = 0;
      response->header.unique = requestId;
      return kj::mv(response);
    }, [this, requestId, defaultError](kj::Exception&& e) {
      auto errorResponse = kj::heap<ResponseBase>();
      errorResponse->header.error = -defaultError;  // TODO(someday): Real error numbers.
      errorResponse->header.unique = requestId;
      return kj::mv(errorResponse);
    }).then([this, requestId](auto&& response) {
      completeTask(requestId);
      writeResponse(kj::mv(response));
    }).eagerlyEvaluate([this](kj::Exception&& exception) {
      // We only get here if the write failed. Abort.
      abortReadLoop->reject(kj::mv(exception));
    });

    KJ_ASSERT(tasks.insert(std::make_pair(requestId, kj::mv(promise))).second);
  }

  void sendReply(uint64_t requestId, kj::Own<ResponseBase>&& response) {
    response->header.error = 0;
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
        switch (newObj->idType) {
          case IdType::NODE: {
            auto insertResult = nodeMap.insert(std::make_pair(newObj->id,
                NodeMapEntry { newObj->cap.castAs<fuse::Node>(), 0 }));
            ++insertResult.first->second.refcount;
            break;
          }
          case IdType::FILE:
            fileMap.insert(std::make_pair(newObj->id,
                FileMapEntry { newObj->cap.castAs<fuse::File>() }));
            break;
          case IdType::DIRECTORY:
            directoryMap.insert(std::make_pair(newObj->id,
                DirectoryMapEntry { newObj->cap.castAs<fuse::Directory>() }));
            break;
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
            // libfuse simply rentries on ENOENT. Comment says that ENOENT means "the operation
            // was interrupted", but I can't tell what that's supposed to mean. It makes sense
            // for write() but what operation is being interrupted on read()? Well, anyway, we do
            // what libfuse does and retry in this case.
            continue;
          case EAGAIN:
            // No data to read.  Try again later.
            return eventPort.onFdEvent(fuseFd, POLLIN).then([this](short) { return readLoop(); });
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
    auto iter = nodeMap.find(header.nodeid);
    KJ_REQUIRE(header.nodeid == 0 || iter != nodeMap.end(),
        "Kernel asked for unknown node ID.", header.nodeid);
    fuse::Node::Client node = header.nodeid == 0 ? nullptr : iter->second.node;

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
        sendReply(header.unique, kj::mv(reply));
        break;
      }

      case FUSE_DESTROY:
        return false;

      case FUSE_FORGET: {
        auto requestBody = consumeStruct<struct fuse_forget_in>(body);
        if ((iter->second.refcount -= requestBody.nlookup) == 0) {
          nodeMap.erase(iter);
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
        auto request = node.lookupRequest(
            capnp::MessageSize { name.size() / sizeof(capnp::word) + 8, 0 });
        request.setName(name);

        auto requestId = header.unique;
        auto promise = request.send();
        auto attrPromise = promise.getNode().getAttributesRequest(capnp::MessageSize {4, 0}).send();

        addReplyTask(requestId, ENOENT, promise.then(
            [this, KJ_MVCAP(attrPromise), requestId](auto&& lookupResult) mutable {
          return attrPromise.then([this, KJ_MVCAP(lookupResult), requestId]
              (auto&& attrResult) -> kj::Own<ResponseBase> {
            auto reply = allocResponse<struct fuse_entry_out>();

            reply->body.nodeid = nodeIdCounter++;
            reply->body.generation = 0;
            reply->newObject = CapToInsert {
                IdType::NODE, reply->body.nodeid, lookupResult.getNode() };

            translateAttrs(attrResult.getAttributes(), &reply->body.attr);
            if (options.cacheForever) {
              reply->body.entry_valid = 365 * kj::DAYS / kj::SECONDS;
              reply->body.attr_valid = 365 * kj::DAYS / kj::SECONDS;
            } else {
              splitTime(lookupResult.getTtl(),
                  &reply->body.entry_valid, &reply->body.entry_valid_nsec);
              splitTime(attrResult.getTtl(),
                  &reply->body.attr_valid, &reply->body.attr_valid_nsec);
            }

            return kj::mv(reply);
          });
        }));

        break;
      }

      case FUSE_GETATTR:
        addReplyTask(header.unique, EIO, node.getAttributesRequest(capnp::MessageSize {4, 0}).send()
            .then([this](auto&& response) -> kj::Own<ResponseBase> {
          auto reply = allocResponse<struct fuse_attr_out>();
          if (options.cacheForever) {
            reply->body.attr_valid = 365 * kj::DAYS / kj::SECONDS;
          } else {
            splitTime(response.getTtl(), &reply->body.attr_valid, &reply->body.attr_valid_nsec);
          }
          translateAttrs(response.getAttributes(), &reply->body.attr);
          return kj::mv(reply);
        }));
        break;

      case FUSE_READLINK:
        // No input.
        addReplyTask(header.unique, EINVAL, node.readlinkRequest(capnp::MessageSize {4, 0}).send()
            .then([this](auto&& response) -> kj::Own<ResponseBase> {
          auto link = response.getLink();
          auto bytes = kj::arrayPtr(reinterpret_cast<const kj::byte*>(link.begin()), link.size());
          return allocResponse<void>(kj::mv(response), bytes);
        }));
        break;

      case FUSE_OPEN: {
        auto request = consumeStruct<struct fuse_open_in>(body);

        if ((request.flags & O_ACCMODE) != O_RDONLY) {
          sendError(header.unique, EROFS);
          break;
        }

        // TODO(perf): Can we assume the kernel will check permissions before open()? If so,
        //   perhaps we ought to assume this should always succeed and thus pipeline it?
        addReplyTask(header.unique, EIO, node.openAsFileRequest(capnp::MessageSize {4, 0}).send()
            .then([this](auto&& response) -> kj::Own<ResponseBase> {
          auto reply = allocResponse<struct fuse_open_out>();
          reply->body.fh = handleCounter++;
          reply->newObject = CapToInsert { IdType::FILE, reply->body.fh, response.getFile() };
          // TODO(someday):  Fill in open_flags, especially "nonseekable"?  See FOPEN_* in fuse.h.
          if (options.cacheForever) reply->body.open_flags |= FOPEN_KEEP_CACHE;
          return kj::mv(reply);
        }));
        break;
      }

      case FUSE_READ: {
        auto request = consumeStruct<struct fuse_read_in>(body);

        auto iter2 = fileMap.find(request.fh);
        KJ_REQUIRE(iter2 != fileMap.end(), "Kernel requested invalid file handle?");

        auto rpc = iter2->second.cap.readRequest(capnp::MessageSize {4, 0});
        rpc.setOffset(request.offset);
        rpc.setSize(request.size);
        addReplyTask(header.unique, EIO, rpc.send()
            .then([this](auto&& response) -> kj::Own<ResponseBase> {
          auto bytes = response.getData();
          auto reply = allocResponse<void>(kj::mv(response), bytes);
          return kj::mv(reply);
        }));
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
        addReplyTask(header.unique, EIO,
            node.openAsDirectoryRequest(capnp::MessageSize {4, 0}).send()
            .then([this](auto&& response) -> kj::Own<ResponseBase> {
          auto reply = allocResponse<struct fuse_open_out>();
          reply->body.fh = handleCounter++;
          reply->newObject = CapToInsert {
              IdType::DIRECTORY, reply->body.fh, response.getDirectory() };
          return kj::mv(reply);
        }));
        break;
      }

      case FUSE_READDIR: {
        auto request = consumeStruct<struct fuse_read_in>(body);

        auto iter2 = directoryMap.find(request.fh);
        KJ_REQUIRE(iter2 != directoryMap.end(), "Kernel requested invalid directory handle?");

        auto rpc = iter2->second.cap.readRequest(capnp::MessageSize {4, 0});
        rpc.setOffset(request.offset);

        // Annoyingly, request.size is actually a size, in bytes. How many entries fit into that
        // size is dependent on the entry names as well as the size of fuse_dirent. It would be
        // annoying for implementations to have to compute this, so instead we make an estimate
        // based on the assumption that the average file name is between 8 and 16 characters.  If
        // file names turn out to be shorter, this may mean we produce a short read, but that
        // appears to be OK -- the kernel will only assume EOF if the result is completely empty.
        // If file names turn out to be longer, we may end up truncating the resulting list and
        // then re-requesting it.  Someday we could implement some sort of streaming here to fix
        // this, but that will be pretty ugly and it probably doesn't actually matter that much.
        rpc.setCount(request.size / (sizeof(struct fuse_dirent) + 16));

        auto requestedSize = request.size;
        addReplyTask(header.unique, EIO, rpc.send()
            .then([this, requestedSize](auto&& response) -> kj::Own<ResponseBase> {
          auto entries = response.getEntries();
          size_t totalBytes = 0;
          for (auto entry: entries) {
            // Carefulyl check whether we'll go over the requested size if we add this entry.  If
            // so, break now.
            size_t next = totalBytes + FUSE_DIRENT_ALIGN(FUSE_NAME_OFFSET + entry.getName().size());
            if (next > requestedSize) {
              break;
            }
            totalBytes = next;
          }

          auto bytes = kj::heapArray<kj::byte>(totalBytes);
          kj::byte* pos = bytes.begin();
          memset(pos, 0, bytes.size());

          for (auto entry: entries) {
            auto& dirent = *reinterpret_cast<struct fuse_dirent*>(pos);
            auto name = entry.getName();

            dirent.ino = entry.getInodeNumber();
            dirent.off = entry.getNextOffset();
            dirent.namelen = name.size();
            dirent.type = DT_UNKNOWN;
            switch (entry.getType()) {
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
        }));
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
          addReplyTask(header.unique, EACCES,
              node.getAttributesRequest(capnp::MessageSize {4, 0}).send()
              .then([this, mask](auto&& response) -> kj::Own<ResponseBase> {
            // TODO(someday):  Account for uid/gid?  Currently irrelevant.
            if (mask & R_OK) {
              KJ_REQUIRE(response.getAttributes().getPermissions() & S_IROTH);
            }
            if (mask & X_OK) {
              KJ_REQUIRE(response.getAttributes().getPermissions() & S_IXOTH);
            }
            return allocEmptyResponse();
          }));
        } else {
          sendReply(header.unique, allocEmptyResponse());
        }

        break;
      }

      case FUSE_INTERRUPT: {
        auto request = consumeStruct<struct fuse_interrupt_in>(body);
        if (tasks.erase(request.unique) > 0) {
          // We successfully canceled this task, so indicate that it failed.
          sendError(request.unique, EINTR);
        }
        break;
      }

      case FUSE_FLUSH:
        // This seems to be called on close() even for files opened read-only.
        sendReply(header.unique, allocEmptyResponse());
        break;

        // TODO(someday): Missing read-only syscalls: statfs, getxaddr, listxaddr, locking,
        //     readdirplus (we currently set protocol version to pre-readdirplus to avoid it)
        // TODO(someday): Write calls.

      case FUSE_STATFS:
      case FUSE_GETXATTR:
      case FUSE_LISTXATTR:
      case FUSE_GETLK:
      case FUSE_SETLK:
      case FUSE_SETLKW:
      case CUSE_INIT:
        sendError(header.unique, ENOSYS);

      default:
        // All other opcodes involve writes.
        sendError(header.unique, EROFS);
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

  void translateAttrs(fuse::Node::Attributes::Reader src, struct fuse_attr* dst) {
    memset(dst, 0, sizeof(*dst));

    dst->ino = src.getInodeNumber();
    dst->size = src.getSize();
    dst->blocks = src.getBlockCount();

    splitTime(src.getLastAccessTime(), &dst->atime, &dst->atimensec);
    splitTime(src.getLastModificationTime(), &dst->mtime, &dst->mtimensec);
    splitTime(src.getLastStatusChangeTime(), &dst->ctime, &dst->ctimensec);

    dst->mode = src.getPermissions();

    switch (src.getType()) {
      case fuse::Node::Type::UNKNOWN:                                break;
      case fuse::Node::Type::BLOCK_DEVICE:     dst->mode |= S_IFBLK; break;
      case fuse::Node::Type::CHARACTER_DEVICE: dst->mode |= S_IFCHR; break;
      case fuse::Node::Type::DIRECTORY:        dst->mode |= S_IFDIR; break;
      case fuse::Node::Type::FIFO:             dst->mode |= S_IFIFO; break;
      case fuse::Node::Type::SYMLINK:          dst->mode |= S_IFLNK; break;
      case fuse::Node::Type::REGULAR:          dst->mode |= S_IFREG; break;
      case fuse::Node::Type::SOCKET:           dst->mode |= S_IFSOCK; break;
    }

    dst->nlink = src.getLinkCount();
    dst->uid = src.getOwnerId();
    dst->gid = src.getGroupId();
    dst->rdev = makedev(src.getDeviceMajor(), src.getDeviceMinor());
    dst->blksize = src.getBlockSize();
  }
};

kj::Promise<void> bindFuse(kj::UnixEventPort& eventPort, int fuseFd, fuse::Node::Client root,
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

class FileImpl final: public fuse::File::Server {
public:
  explicit FileImpl(kj::StringPtr path) {
    int ifd;
    KJ_SYSCALL(ifd = open(path.cStr(), O_RDONLY), path);
    fd = kj::AutoCloseFd(ifd);
  }

protected:
  kj::Promise<void> read(ReadContext context) override {
    auto params = context.getParams();
    auto size = params.getSize();
    auto offset = params.getOffset();

    KJ_REQUIRE(size < (1 << 22), "read too large", size);

    auto results = context.getResults(
        capnp::MessageSize { size / sizeof(capnp::word) + 4 });

    kj::byte* ptr = results.initData(size).begin();

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
      // Oops, we hit EOF before filling the buffer. Truncate. Note that since this is the
      // most recent allocation, this will actually un-allocate the space in the message. :)
      auto orphan = results.disownData();
      orphan.truncate(params.getSize() - size);
      results.adoptData(kj::mv(orphan));
    }

    return kj::READY_NOW;
  }

private:
  kj::AutoCloseFd fd;
};

class DirectoryImpl final: public fuse::Directory::Server {
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

protected:
  kj::Promise<void> read(ReadContext context) {
    auto params = context.getParams();

    if (params.getOffset() != currentOffset) {
      seekdir(dir, params.getOffset());
      currentOffset = params.getOffset();
    }

    auto requestedCount = params.getCount();
    KJ_REQUIRE(requestedCount < 8192, "readdir too large", requestedCount);

    kj::Vector<struct dirent> entries(requestedCount);

    uint count = 0;
    capnp::MessageSize messageSize = { 6, 0 };
    for (; count < requestedCount; count++) {
      struct dirent* ent = readdir(dir);
      if (ent == nullptr) {
        // End of directory.
        break;
      }

      currentOffset = ent->d_off;

      entries.add(*ent);

      // Don't forget NUL byte...
      messageSize.wordCount += capnp::sizeInWords<fuse::Directory::Entry>() +
          (strlen(ent->d_name) + sizeof(capnp::word)) / sizeof(capnp::word);
    }

    auto builder = context.getResults(messageSize).initEntries(count);

    for (size_t i: kj::indices(entries)) {
      auto entryBuilder = builder[i];
      auto& entry = entries[i];

      entryBuilder.setInodeNumber(entry.d_ino);
      entryBuilder.setNextOffset(entry.d_off);

      switch (entry.d_type) {
        case DT_BLK:  entryBuilder.setType(fuse::Node::Type::BLOCK_DEVICE); break;
        case DT_CHR:  entryBuilder.setType(fuse::Node::Type::CHARACTER_DEVICE); break;
        case DT_DIR:  entryBuilder.setType(fuse::Node::Type::DIRECTORY); break;
        case DT_FIFO: entryBuilder.setType(fuse::Node::Type::FIFO); break;
        case DT_LNK:  entryBuilder.setType(fuse::Node::Type::SYMLINK); break;
        case DT_REG:  entryBuilder.setType(fuse::Node::Type::REGULAR); break;
        case DT_SOCK: entryBuilder.setType(fuse::Node::Type::SOCKET); break;
        default:      entryBuilder.setType(fuse::Node::Type::UNKNOWN); break;
      }

      entryBuilder.setName(entry.d_name);
    }

    return kj::READY_NOW;
  }

private:
  DIR* dir;
  size_t currentOffset;
};

class NodeImpl final: public fuse::Node::Server {
public:
  NodeImpl(kj::StringPtr path, kj::Duration ttl)
      : path(kj::heapString(path)), ttl(ttl) {
    updateStats();  // Mainly to throw an exception if it doesn't exist.
  }

protected:
  kj::Promise<void> lookup(LookupContext context) override {
    auto name = context.getParams().getName();

    KJ_REQUIRE(name != "." && name != "..", "Please implement . and .. at a higher level.");

    auto results = context.getResults(capnp::MessageSize {8, 1});
    results.setNode(kj::heap<NodeImpl>(kj::str(path, '/', name), ttl));
    results.setTtl(ttl / kj::NANOSECONDS);
    return kj::READY_NOW;
  }

  kj::Promise<void> getAttributes(GetAttributesContext context) override {
    updateStats();

    auto results = context.getResults(capnp::MessageSize { 16, 0 });
    auto attrs = results.getAttributes();
    attrs.setInodeNumber(stats.st_ino);

    switch (stats.st_mode & S_IFMT) {
      case S_IFBLK:  attrs.setType(fuse::Node::Type::BLOCK_DEVICE); break;
      case S_IFCHR:  attrs.setType(fuse::Node::Type::CHARACTER_DEVICE); break;
      case S_IFDIR:  attrs.setType(fuse::Node::Type::DIRECTORY); break;
      case S_IFIFO:  attrs.setType(fuse::Node::Type::FIFO); break;
      case S_IFLNK:  attrs.setType(fuse::Node::Type::SYMLINK); break;
      case S_IFREG:  attrs.setType(fuse::Node::Type::REGULAR); break;
      case S_IFSOCK: attrs.setType(fuse::Node::Type::SOCKET); break;
      default:       attrs.setType(fuse::Node::Type::UNKNOWN); break;
    }

    attrs.setPermissions(stats.st_mode & ~S_IFMT);
    attrs.setLinkCount(stats.st_nlink);
    attrs.setOwnerId(stats.st_uid);
    attrs.setGroupId(stats.st_gid);
    attrs.setDeviceMajor(major(stats.st_rdev));
    attrs.setDeviceMinor(minor(stats.st_rdev));
    attrs.setSize(stats.st_size);
    attrs.setBlockCount(stats.st_blocks);
    attrs.setBlockSize(stats.st_blksize);
    attrs.setLastAccessTime(toNanos(stats.st_atim));
    attrs.setLastModificationTime(toNanos(stats.st_mtim));
    attrs.setLastStatusChangeTime(toNanos(stats.st_ctim));
    results.setTtl(ttl / kj::NANOSECONDS);

    return kj::READY_NOW;
  }

  kj::Promise<void> openAsFile(OpenAsFileContext context) override {
    auto file = kj::heap<FileImpl>(path);
    context.getResults(capnp::MessageSize {2, 1}).setFile(kj::mv(file));
    return kj::READY_NOW;
  }

  kj::Promise<void> openAsDirectory(OpenAsDirectoryContext context) override {
    auto directory = kj::heap<DirectoryImpl>(path);
    context.getResults(capnp::MessageSize {2, 1}).setDirectory(kj::mv(directory));
    return kj::READY_NOW;
  }

  kj::Promise<void> readlink(ReadlinkContext context) override {
    char buffer[PATH_MAX + 1];
    int n;
    KJ_SYSCALL(n = ::readlink(path.cStr(), buffer, PATH_MAX));
    buffer[n] = '\0';
    context.getResults(capnp::MessageSize {n / sizeof(capnp::word) + 4, 0}).setLink(buffer);
    return kj::READY_NOW;
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
      KJ_SYSCALL(lstat(path.cStr(), &stats));
    }
  }
};

}  // namespace

fuse::Node::Client newLoopbackFuseNode(kj::StringPtr path, kj::Duration cacheTtl) {
  return kj::heap<NodeImpl>(path, cacheTtl);
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
