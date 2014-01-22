// Hacky node.js bindings for Cap'n Proto.
//
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

#include <node.h>
#include <capnp/dynamic.h>
#include <capnp/schema-parser.h>
#include <kj/debug.h>
#include <typeinfo>
#include <uv.h>
#include <kj/async.h>
#include <kj/async-io.h>
#include <errno.h>
#include <unistd.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <unordered_map>
#include <inttypes.h>

namespace {

typedef unsigned char byte;

#define UV_CALL(code, loop, ...) \
  KJ_ASSERT(code == 0, uv_strerror(uv_last_error(loop)), ##__VA_ARGS__)

class UvEventPort: public kj::EventPort {
public:
  UvEventPort(uv_loop_t* loop): loop(loop), kjLoop(*this) {}
  ~UvEventPort() {
    if (scheduled) {
      UV_CALL(uv_timer_stop(&timer), loop);
    }
  }

  kj::EventLoop& getKjLoop() { return kjLoop; }
  uv_loop_t* getUvLoop() { return loop; }

  void wait() override {
    // TODO(someday):  Detect if loop will never have an event.
    UV_CALL(uv_run(loop, UV_RUN_ONCE), loop);
  }

  void poll() override {
    UV_CALL(uv_run(loop, UV_RUN_NOWAIT), loop);
  }

  void setRunnable(bool runnable) override {
    if (runnable != this->runnable) {
      this->runnable = runnable;
      if (runnable && !scheduled) {
        schedule();
      }
    }
  }

private:
  uv_loop_t* loop;
  uv_timer_t timer;
  kj::EventLoop kjLoop;
  bool runnable = false;
  bool scheduled = false;

  void schedule() {
    UV_CALL(uv_timer_init(loop, &timer), loop);
    timer.data = this;
    UV_CALL(uv_timer_start(&timer, &doRun, 0, 0), loop);
    scheduled = true;
  }

  void run() {
    KJ_ASSERT(scheduled);

    UV_CALL(uv_timer_stop(&timer), loop);

    if (runnable) {
      kjLoop.run();
    }

    scheduled = false;

    if (runnable) {
      // Apparently either we never became non-runnable, or we did but then became runnable again.
      // Since `scheduled` has been true the whole time, we won't have been rescheduled, so do that
      // now.
      schedule();
    } else {
      scheduled = false;
    }
  }

  static void doRun(uv_timer_t* handle, int status) {
    if (status == 0) {
      reinterpret_cast<UvEventPort*>(handle->data)->run();
    }
  }
};

void setNonblocking(int fd) {
  int flags;
  KJ_SYSCALL(flags = fcntl(fd, F_GETFL));
  if ((flags & O_NONBLOCK) == 0) {
    KJ_SYSCALL(fcntl(fd, F_SETFL, flags | O_NONBLOCK));
  }
}

void setCloseOnExec(int fd) {
  int flags;
  KJ_SYSCALL(flags = fcntl(fd, F_GETFD));
  if ((flags & FD_CLOEXEC) == 0) {
    KJ_SYSCALL(fcntl(fd, F_SETFD, flags | FD_CLOEXEC));
  }
}

static constexpr uint NEW_FD_FLAGS =
#if __linux__
    kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC || kj::LowLevelAsyncIoProvider::ALREADY_NONBLOCK ||
#endif
    kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP;
// We always try to open FDs with CLOEXEC and NONBLOCK already set on Linux, but on other platforms
// this is not possible.

class OwnedFileDescriptor {
public:
  OwnedFileDescriptor(uv_loop_t* loop, int fd, uint flags): uvLoop(loop), fd(fd), flags(flags) {
    if (flags & kj::LowLevelAsyncIoProvider::ALREADY_NONBLOCK) {
      KJ_DREQUIRE(fcntl(fd, F_GETFL) & O_NONBLOCK, "You claimed you set NONBLOCK, but you didn't.");
    } else {
      setNonblocking(fd);
    }

    if (flags & kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP) {
      if (flags & kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC) {
        KJ_DREQUIRE(fcntl(fd, F_GETFD) & FD_CLOEXEC,
                    "You claimed you set CLOEXEC, but you didn't.");
      } else {
        setCloseOnExec(fd);
      }
    }

    UV_CALL(uv_poll_init(uvLoop, &uvPoller, fd), uvLoop);
    UV_CALL(uv_poll_start(&uvPoller, 0, &pollCallback), uvLoop);
    uvPoller.data = this;
  }

  ~OwnedFileDescriptor() noexcept(false) {
    if (error == nullptr) {
      UV_CALL(uv_poll_stop(&uvPoller), uvLoop);
    }

    // Don't use KJ_SYSCALL() here because close() should not be repeated on EINTR.
    if ((flags & kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP) && close(fd) < 0) {
      KJ_FAIL_SYSCALL("close", errno, fd) {
        // Recoverable exceptions are safe in destructors.
        break;
      }
    }
  }

  kj::Promise<void> onReadable() {
    KJ_IF_MAYBE(e, error) {
      return kj::cp(*e);
    }

    KJ_REQUIRE(readable == nullptr, "Must wait for previous event to complete.");

    auto paf = kj::newPromiseAndFulfiller<void>();
    readable = kj::mv(paf.fulfiller);

    int flags = UV_READABLE | (writable == nullptr ? 0 : UV_WRITABLE);
    UV_CALL(uv_poll_start(&uvPoller, flags, &pollCallback), uvLoop);

    return kj::mv(paf.promise);
  }

  kj::Promise<void> onWritable() {
    KJ_IF_MAYBE(e, error) {
      return kj::cp(*e);
    }

    KJ_REQUIRE(writable == nullptr, "Must wait for previous event to complete.");

    auto paf = kj::newPromiseAndFulfiller<void>();
    writable = kj::mv(paf.fulfiller);

    int flags = UV_WRITABLE | (readable == nullptr ? 0 : UV_READABLE);
    UV_CALL(uv_poll_start(&uvPoller, flags, &pollCallback), uvLoop);

    return kj::mv(paf.promise);
  }

protected:
  uv_loop_t* const uvLoop;
  const int fd;

private:
  uint flags;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> readable;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> writable;
  kj::Maybe<kj::Exception> error;
  uv_poll_t uvPoller;

  static void pollCallback(uv_poll_t* handle, int status, int events) {
    reinterpret_cast<OwnedFileDescriptor*>(handle->data)->pollDone(status, events);
  }

  void pollDone(int status, int events) {
    if (status != 0) {
      // Error.  Fail both events.
      kj::Exception exception(
            kj::Exception::Nature::OS_ERROR, kj::Exception::Durability::PERMANENT,
            __FILE__, __LINE__, kj::heapString(uv_strerror(uv_last_error(uvLoop))));
      KJ_IF_MAYBE(r, readable) {
        r->get()->reject(kj::cp(exception));
        readable = nullptr;
      }
      KJ_IF_MAYBE(w, writable) {
        w->get()->reject(kj::cp(exception));
        writable = nullptr;
      }
      error = kj::mv(exception);
      UV_CALL(uv_poll_stop(&uvPoller), uvLoop);

    } else {
      // Fire the events.
      if (events & UV_READABLE) {
        KJ_ASSERT_NONNULL(readable)->fulfill();
        readable = nullptr;
      }
      if (events & UV_WRITABLE) {
        KJ_ASSERT_NONNULL(writable)->fulfill();
        writable = nullptr;
      }

      // Update the poll flags.
      int flags = (readable == nullptr ? 0 : UV_READABLE) |
                  (writable == nullptr ? 0 : UV_WRITABLE);
      UV_CALL(uv_poll_start(&uvPoller, flags, &pollCallback), uvLoop);
    }
  }
};

class UvIoStream: public OwnedFileDescriptor, public kj::AsyncIoStream {
  // IoStream implementation on top of libuv.  This is mostly a copy of the UnixEventPort-based
  // implementation in kj/async-io.c++.  We use uv_poll, which the libuv docs say is slow
  // "especially on Windows".  I'm guessing it's not so slow on Unix, since it matches the
  // underlying APIs.
  //
  // TODO(cleanup):  Allow better code sharing between the two.

public:
  UvIoStream(uv_loop_t* loop, int fd, uint flags)
      : OwnedFileDescriptor(loop, fd, flags) {}
  virtual ~UvIoStream() noexcept(false) {}

  kj::Promise<size_t> read(void* buffer, size_t minBytes, size_t maxBytes) override {
    return tryReadInternal(buffer, minBytes, maxBytes, 0).then([=](size_t result) {
      KJ_REQUIRE(result >= minBytes, "Premature EOF") {
        // Pretend we read zeros from the input.
        memset(reinterpret_cast<byte*>(buffer) + result, 0, minBytes - result);
        return minBytes;
      }
      return result;
    });
  }

  kj::Promise<size_t> tryRead(void* buffer, size_t minBytes, size_t maxBytes) override {
    return tryReadInternal(buffer, minBytes, maxBytes, 0);
  }

  kj::Promise<void> write(const void* buffer, size_t size) override {
    ssize_t writeResult;
    KJ_NONBLOCKING_SYSCALL(writeResult = ::write(fd, buffer, size)) {
      return kj::READY_NOW;
    }

    // A negative result means EAGAIN, which we can treat the same as having written zero bytes.
    size_t n = writeResult < 0 ? 0 : writeResult;

    if (n == size) {
      return kj::READY_NOW;
    } else {
      buffer = reinterpret_cast<const byte*>(buffer) + n;
      size -= n;
    }

    return onReadable().then([=]() {
      return write(buffer, size);
    });
  }

  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const byte>> pieces) override {
    if (pieces.size() == 0) {
      return writeInternal(nullptr, nullptr);
    } else {
      return writeInternal(pieces[0], pieces.slice(1, pieces.size()));
    }
  }

  void shutdownWrite() override {
    // There's no legitimate way to get an AsyncStreamFd that isn't a socket through the
    // UnixAsyncIoProvider interface.
    KJ_SYSCALL(shutdown(fd, SHUT_WR));
  }

private:
  kj::Promise<size_t> tryReadInternal(void* buffer, size_t minBytes, size_t maxBytes,
                                      size_t alreadyRead) {
    // `alreadyRead` is the number of bytes we have already received via previous reads -- minBytes,
    // maxBytes, and buffer have already been adjusted to account for them, but this count must
    // be included in the final return value.

    ssize_t n;
    KJ_NONBLOCKING_SYSCALL(n = ::read(fd, buffer, maxBytes)) {
      return alreadyRead;
    }

    if (n < 0) {
      // Read would block.
      return onReadable().then([=]() {
        return tryReadInternal(buffer, minBytes, maxBytes, alreadyRead);
      });
    } else if (n == 0) {
      // EOF -OR- maxBytes == 0.
      return alreadyRead;
    } else if (kj::implicitCast<size_t>(n) < minBytes) {
      // The kernel returned fewer bytes than we asked for (and fewer than we need).  This indicates
      // that we're out of data.  It could also mean we're at EOF.  We could check for EOF by doing
      // another read just to see if it returns zero, but that would mean making a redundant syscall
      // every time we receive a message on a long-lived connection.  So, instead, we optimistically
      // asume we are not at EOF and return to the event loop.
      //
      // If libuv provided notification of HUP or RDHUP, we could do better here...
      buffer = reinterpret_cast<byte*>(buffer) + n;
      minBytes -= n;
      maxBytes -= n;
      alreadyRead += n;
      return onReadable().then([=]() {
        return tryReadInternal(buffer, minBytes, maxBytes, alreadyRead);
      });
    } else {
      // We read enough to stop here.
      return alreadyRead + n;
    }
  }

  kj::Promise<void> writeInternal(kj::ArrayPtr<const byte> firstPiece,
                                  kj::ArrayPtr<const kj::ArrayPtr<const byte>> morePieces) {
    KJ_STACK_ARRAY(struct iovec, iov, 1 + morePieces.size(), 16, 128);

    // writev() interface is not const-correct.  :(
    iov[0].iov_base = const_cast<byte*>(firstPiece.begin());
    iov[0].iov_len = firstPiece.size();
    for (uint i = 0; i < morePieces.size(); i++) {
      iov[i + 1].iov_base = const_cast<byte*>(morePieces[i].begin());
      iov[i + 1].iov_len = morePieces[i].size();
    }

    ssize_t writeResult;
    KJ_NONBLOCKING_SYSCALL(writeResult = ::writev(fd, iov.begin(), iov.size())) {
      // Error.

      // We can't "return kj::READY_NOW;" inside this block because it causes a memory leak due to
      // a bug that exists in both Clang and GCC:
      //   http://gcc.gnu.org/bugzilla/show_bug.cgi?id=33799
      //   http://llvm.org/bugs/show_bug.cgi?id=12286
      goto error;
    }
    if (false) {
    error:
      return kj::READY_NOW;
    }

    // A negative result means EAGAIN, which we can treat the same as having written zero bytes.
    size_t n = writeResult < 0 ? 0 : writeResult;

    // Discard all data that was written, then issue a new write for what's left (if any).
    for (;;) {
      if (n < firstPiece.size()) {
        // Only part of the first piece was consumed.  Wait for POLLOUT and then write again.
        firstPiece = firstPiece.slice(n, firstPiece.size());
        return onWritable().then([=]() {
          return writeInternal(firstPiece, morePieces);
        });
      } else if (morePieces.size() == 0) {
        // First piece was fully-consumed and there are no more pieces, so we're done.
        KJ_DASSERT(n == firstPiece.size(), n);
        return kj::READY_NOW;
      } else {
        // First piece was fully consumed, so move on to the next piece.
        n -= firstPiece.size();
        firstPiece = morePieces[0];
        morePieces = morePieces.slice(1, morePieces.size());
      }
    }
  }
};

class UvConnectionReceiver final: public kj::ConnectionReceiver, public OwnedFileDescriptor {
  // Like UvIoStream but for ConnectionReceiver.  This is also largely copied from kj/async-io.c++.

public:
  UvConnectionReceiver(uv_loop_t* loop, int fd, uint flags)
      : OwnedFileDescriptor(loop, fd, flags) {}

  kj::Promise<kj::Own<kj::AsyncIoStream>> accept() override {
    int newFd;

  retry:
#if __linux__
    newFd = ::accept4(fd, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
#else
    newFd = ::accept(fd, nullptr, nullptr);
#endif

    if (newFd >= 0) {
      return kj::Own<kj::AsyncIoStream>(kj::heap<UvIoStream>(uvLoop, newFd, NEW_FD_FLAGS));
    } else {
      int error = errno;

      switch (error) {
        case EAGAIN:
#if EAGAIN != EWOULDBLOCK
        case EWOULDBLOCK:
#endif
          // Not ready yet.
          return onReadable().then([this]() {
            return accept();
          });

        case EINTR:
        case ENETDOWN:
        case EPROTO:
        case EHOSTDOWN:
        case EHOSTUNREACH:
        case ENETUNREACH:
        case ECONNABORTED:
        case ETIMEDOUT:
          // According to the Linux man page, accept() may report an error if the accepted
          // connection is already broken.  In this case, we really ought to just ignore it and
          // keep waiting.  But it's hard to say exactly what errors are such network errors and
          // which ones are permanent errors.  We've made a guess here.
          goto retry;

        default:
          KJ_FAIL_SYSCALL("accept", error);
      }

    }
  }

  uint getPort() override {
    socklen_t addrlen;
    union {
      struct sockaddr generic;
      struct sockaddr_in inet4;
      struct sockaddr_in6 inet6;
    } addr;
    addrlen = sizeof(addr);
    KJ_SYSCALL(getsockname(fd, &addr.generic, &addrlen));
    switch (addr.generic.sa_family) {
      case AF_INET: return ntohs(addr.inet4.sin_port);
      case AF_INET6: return ntohs(addr.inet6.sin6_port);
      default: return 0;
    }
  }
};

class UvLowLevelAsyncIoProvider final: public kj::LowLevelAsyncIoProvider {
public:
  UvLowLevelAsyncIoProvider(uv_loop_t* loop): eventPort(loop), waitScope(eventPort.getKjLoop()) {}

  inline kj::WaitScope& getWaitScope() { return waitScope; }

  kj::Own<kj::AsyncInputStream> wrapInputFd(int fd, uint flags = 0) override {
    return kj::heap<UvIoStream>(eventPort.getUvLoop(), fd, flags);
  }
  kj::Own<kj::AsyncOutputStream> wrapOutputFd(int fd, uint flags = 0) override {
    return kj::heap<UvIoStream>(eventPort.getUvLoop(), fd, flags);
  }
  kj::Own<kj::AsyncIoStream> wrapSocketFd(int fd, uint flags = 0) override {
    return kj::heap<UvIoStream>(eventPort.getUvLoop(), fd, flags);
  }
  kj::Promise<kj::Own<kj::AsyncIoStream>> wrapConnectingSocketFd(int fd, uint flags = 0) override {
    auto result = kj::heap<UvIoStream>(eventPort.getUvLoop(), fd, flags);
    auto connected = result->onWritable();
    return connected.then(kj::mvCapture(result,
        [fd](kj::Own<kj::AsyncIoStream>&& stream) {
          int err;
          socklen_t errlen = sizeof(err);
          KJ_SYSCALL(getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &errlen));
          if (err != 0) {
            KJ_FAIL_SYSCALL("connect()", err) { break; }
          }
          return kj::mv(stream);
        }));
  }
  kj::Own<kj::ConnectionReceiver> wrapListenSocketFd(int fd, uint flags = 0) override {
    return kj::heap<UvConnectionReceiver>(eventPort.getUvLoop(), fd, flags);
  }

private:
  UvEventPort eventPort;
  kj::WaitScope waitScope;
};

// =======================================================================================

template <typename T>
class OwnHandle {
public:
  OwnHandle() = default;
  KJ_DISALLOW_COPY(OwnHandle);
  inline OwnHandle(const v8::Handle<T>& other)
      : handle(v8::Persistent<T>::New(other)) {}
  inline OwnHandle(OwnHandle&& other): handle(other.handle) {
    other.handle.Clear();
  }
  inline ~OwnHandle() {
    if (!handle.IsEmpty()) {
      handle.Dispose();
    }
  }

  inline OwnHandle& operator=(OwnHandle&& other) {
    handle = other.handle;
    other.handle.Clear();
    return *this;
  }
  inline OwnHandle& operator=(const v8::Handle<T>& other) {
    handle = v8::Persistent<T>::New(other);
    return *this;
  }

  inline bool operator==(decltype(nullptr)) { return handle.IsEmpty(); }
  inline bool operator!=(decltype(nullptr)) { return !handle.IsEmpty(); }
  inline T* operator->() const { return handle.operator->(); }

  inline const v8::Handle<T>& get() const { return handle; }

private:
  v8::Persistent<T> handle;
};

kj::String toKjString(v8::Handle<v8::String> handle) {
  auto buf = kj::heapArray<char>(handle->Utf8Length() + 1);
  handle->WriteUtf8(buf.begin(), buf.size());
  buf[buf.size() - 1] = 0;
  return kj::String(kj::mv(buf));
}

kj::String toKjString(v8::Handle<v8::Value> handle) {
  v8::HandleScope scope;
  return toKjString(handle->ToString());
}

#define V82KJ_STR(name, handle, sizeHint) \
  char name##_buf[sizeHint]; \
  kj::Array<char> name##_heap; \
  kj::StringPtr name; \
  { \
    v8::Handle<v8::String> v8str = handle->ToString(); \
    char* ptr; \
    size_t len = v8str->Utf8Length(); \
    if (len < sizeHint) { \
      ptr = name##_buf; \
    } else { \
      name##_heap = kj::heapArray<char>(len + 1); \
      ptr = name##_heap.begin(); \
    } \
    v8str->WriteUtf8(ptr, len); \
    ptr[len] = '\0'; \
    name = kj::StringPtr(ptr, len); \
  }


class Wrapper {
  // Wraps C++ objects in v8 handles.

public:
  Wrapper() {
    v8::HandleScope scope;
    tpl = v8::ObjectTemplate::New();
    tpl->SetInternalFieldCount(2);
  }

  template <typename T>
  v8::Local<v8::Object> wrap(T* ptr) {
    v8::HandleScope scope;
    v8::Local<v8::Object> obj = tpl->NewInstance();
    obj->SetPointerInInternalField(0, const_cast<std::type_info*>(&typeid(T)));
    obj->SetPointerInInternalField(1, ptr);
    v8::Persistent<v8::Object>::New(obj)
        .MakeWeak(reinterpret_cast<void*>(ptr), deleteAttachment<T>);
    return scope.Close(obj);
  }

  template <typename T>
  static kj::Maybe<T&> unwrap(v8::Handle<v8::Value> hdl) {
    v8::Handle<v8::Object> obj(v8::Object::Cast(*hdl));

    if (obj->InternalFieldCount() != 2 ||
        obj->GetPointerFromInternalField(0) != &typeid(T)) {
      kj::Exception exception(
            kj::Exception::Nature::PRECONDITION, kj::Exception::Durability::PERMANENT,
            __FILE__, __LINE__,
            kj::str("Type error (in Cap'n Proto glue).  Expected: ", typeid(T).name()));
      v8::ThrowException(v8::Exception::TypeError(
          v8::String::New(kj::str(exception).cStr())));
      return nullptr;
    } else {
      return *reinterpret_cast<T*>(obj->GetPointerFromInternalField(1));
    }
  }

private:
  OwnHandle<v8::ObjectTemplate> tpl;

  template <typename T>
  static void deleteAttachment(v8::Persistent<v8::Value> object, void* ptr) {
    object.Dispose();
    delete reinterpret_cast<T*>(ptr);
  }
};

struct CapnpContext {
  // Shared context initialized when the module starts up.
  //
  // TODO(cleanup):  This structure ends up containing cyclic persistent handles and so it will
  //   never be garbage-collected.  This is probably not a big deal in practice since node will
  //   cache the module until shutdown anyway, but it feels wrong.  It could perhaps be fixed by
  //   inheriting from ObjectWrap and getting rid of `Wrapper`.

  UvLowLevelAsyncIoProvider llaiop;
  kj::Own<kj::AsyncIoProvider> aiop;
  capnp::SchemaParser parser;
  Wrapper wrapper;
  OwnHandle<v8::FunctionTemplate> rpcClientTpl;
  std::unordered_map<uint64_t, OwnHandle<v8::FunctionTemplate>> interfaceTpls;

  CapnpContext()
    : llaiop(uv_default_loop()),
      aiop(kj::newAsyncIoProvider(llaiop)) {}
};

v8::Local<v8::Object> schemaToObject(capnp::ParsedSchema schema, CapnpContext& context,
                                     v8::Handle<v8::Value> wrappedContext) {
  v8::HandleScope scope;

  auto result = context.wrapper.wrap(new capnp::ParsedSchema(schema));

//  result->SetHiddenValue(v8::String::NewSymbol("capnp"), wrappedContext);

  for (auto nested: schema.getProto().getNestedNodes()) {
    kj::StringPtr name = nested.getName();
    result->Set(v8::String::NewSymbol(name.cStr()),
                schemaToObject(schema.getNested(name), context, wrappedContext));
  }

  return scope.Close(result);
}

v8::Handle<v8::Value> import(const v8::Arguments& args) {
  v8::HandleScope scope;
  KJ_IF_MAYBE(context, Wrapper::unwrap<CapnpContext>(args.Data())) {
    V82KJ_STR(path, args[0], 128);
    // TODO(soon):  Use NODE_PATH as import path.
    capnp::ParsedSchema schema;
    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      schema = context->parser.parseDiskFile(path, path, nullptr);
    })) {
      v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(*exception).cStr())));
      return v8::Handle<v8::Value>();
    } else {
      return scope.Close(schemaToObject(schema, *context, args.Data()));
    }
  } else {
    // Exception already thrown.
    return v8::Handle<v8::Value>();
  }
}

class RpcConnection: public kj::Refcounted {
public:
  RpcConnection(kj::Own<kj::AsyncIoStream>&& streamParam)
      : stream(kj::mv(streamParam)),
        network(*stream, capnp::rpc::twoparty::Side::CLIENT),
        rpcSystem(capnp::makeRpcClient(network)) {}

  ~RpcConnection() {
    KJ_DBG("~RpcConnection");
  }

  capnp::Capability::Client import(kj::StringPtr ref) {
    capnp::MallocMessageBuilder builder;
    auto root = builder.getRoot<capnp::rpc::SturdyRef>();
    auto hostId = root.getHostId().initAs<capnp::rpc::twoparty::SturdyRefHostId>();
    hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
    root.getObjectId().setAs<capnp::Text>(ref);

    return rpcSystem.restore(hostId, root.getObjectId());
  }

  kj::Own<RpcConnection> addRef() {
    return kj::addRef(*this);
  }

private:
  kj::Own<kj::AsyncIoStream> stream;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::SturdyRefHostId> rpcSystem;
};

class CapClient: public node::ObjectWrap {
public:
  inline CapClient(capnp::DynamicCapability::Client cap): cap(kj::mv(cap)) {}

  ~CapClient() noexcept try {
    // This try block will catch exceptions in the member destructors.
  } catch (const kj::Exception& exception) {
    KJ_LOG(ERROR, exception);
  }

  static v8::Handle<v8::FunctionTemplate> getTemplate(
      CapnpContext& context,
      v8::Handle<v8::Value> wrappedContext,
      capnp::InterfaceSchema schema) {
    v8::HandleScope scope;

    auto proto = schema.getProto();
    uint64_t id = proto.getId();
    auto& slot = context.interfaceTpls[id];
    if (slot != nullptr) {
      // Oh good, we already built this template.
      return scope.Close(slot.get());
    }

    auto className = proto.getDisplayName().slice(proto.getDisplayNamePrefixLength());

    v8::Handle<v8::FunctionTemplate> tpl = v8::FunctionTemplate::New(ctor, wrappedContext);
    tpl->SetClassName(v8::String::NewSymbol(className.cStr()));
    tpl->InstanceTemplate()->SetInternalFieldCount(1);

    v8::Handle<v8::FunctionTemplate> sigArgs[1];
    tpl->PrototypeTemplate()->Set("castAs", v8::FunctionTemplate::New(
        castAs, wrappedContext, v8::Signature::New(tpl, 1, sigArgs))->GetFunction());
    slot = tpl;
    return scope.Close(tpl);
  }

  v8::Handle<v8::Object> wrap(CapnpContext& context, v8::Handle<v8::Value> wrappedContext,
                              v8::Handle<v8::Value> rpcClient) {
    v8::HandleScope scope;
    auto tpl = getTemplate(context, wrappedContext, cap.getSchema());
    auto result = tpl->GetFunction()->NewInstance();
    result->SetHiddenValue(v8::String::NewSymbol("rpcClient"), rpcClient);
    ObjectWrap::Wrap(result);
    return scope.Close(result);
  }

private:
  capnp::DynamicCapability::Client cap;

  static v8::Handle<v8::Value> ctor(const v8::Arguments& args) {
    // Hack:  Only intended to be called as part of wrap().
    // TODO(cleanup):  Apparently the constructor is visible as an instance member.  Argh.  We
    //   should probably construct a broken cap rather than handle this by checking for null after
    //   Unwrap() in every method definition.
    return args.This();
  }

  static v8::Handle<v8::Value> castAs(const v8::Arguments& args) {
    v8::HandleScope scope;

    CapClient* self = ObjectWrap::Unwrap<CapClient>(args.Holder());
    if (self == nullptr) {
      v8::ThrowException(v8::Exception::Error(v8::String::New(
          "Why does Javascript expose the constructor as a class member?  Argh.")));
      return v8::Handle<v8::Value>();
    }

    KJ_IF_MAYBE(context, Wrapper::unwrap<CapnpContext>(args.Data())) {
      KJ_IF_MAYBE(schema, Wrapper::unwrap<capnp::ParsedSchema>(args[0])) {
        if (!schema->getProto().isInterface()) {
          v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(
              "Not an interface type: ", schema->getProto().getDisplayName()).cStr())));
          return v8::Handle<v8::Value>();
        }
        CapClient* result = new CapClient(
            self->cap.castAs<capnp::DynamicCapability>(schema->asInterface()));
        return scope.Close(result->wrap(*context, args.Data(),
            args.Holder()->GetHiddenValue(v8::String::NewSymbol("rpcClient"))));
      }
    }

    // Exception already thrown.
    return v8::Handle<v8::Value>();
  }

  // TODO:  close()
};

class RpcClient: public node::ObjectWrap {
public:
  RpcClient(kj::Promise<kj::Own<RpcConnection>> promise)
      : connectPromise(promise.fork()) {}

  ~RpcClient() noexcept try {
    // This try block will catch exceptions in the member destructors.
  } catch (const kj::Exception& exception) {
    KJ_LOG(ERROR, exception);
  }

  static v8::Handle<v8::FunctionTemplate> makeTemplate(v8::Handle<v8::Value> context) {
    v8::Handle<v8::FunctionTemplate> tpl = v8::FunctionTemplate::New(ctor, context);
    tpl->SetClassName(v8::String::NewSymbol("RpcClient"));
    tpl->InstanceTemplate()->SetInternalFieldCount(1);

    v8::Handle<v8::FunctionTemplate> sigArgs[2];
    tpl->PrototypeTemplate()->Set(v8::String::NewSymbol("import"), v8::FunctionTemplate::New(
        import, context, v8::Signature::New(tpl, 2, sigArgs))->GetFunction());
    return tpl;
  }

private:
  kj::ForkedPromise<kj::Own<RpcConnection>> connectPromise;

  static v8::Handle<v8::Value> ctor(const v8::Arguments& args) {
    // Construct a two-party RPC client.
    //
    // params:  (address)

    v8::HandleScope scope;

    KJ_IF_MAYBE(context, Wrapper::unwrap<CapnpContext>(args.Data())) {
      if (args.IsConstructCall()) {
        V82KJ_STR(address, args[0], 128);
        auto client = new RpcClient(context->aiop->getNetwork().parseAddress(address)
            .then([](kj::Own<kj::NetworkAddress>&& addr) {
          return addr->connect();
        }).then([](kj::Own<kj::AsyncIoStream>&& stream) {
          return kj::refcounted<RpcConnection>(kj::mv(stream));
        }));
        client->Wrap(args.This());
        return scope.Close(args.This());
      } else {
        v8::Local<v8::Value> argv[1] = { args[0] };
        return scope.Close(context->rpcClientTpl->GetFunction()->NewInstance(kj::size(argv), argv));
      }
    } else {
      // Exception already thrown.
      return v8::Handle<v8::Value>();
    }
  }

  static v8::Handle<v8::Value> import(const v8::Arguments& args) {
    v8::HandleScope scope;

    KJ_IF_MAYBE(context, Wrapper::unwrap<CapnpContext>(args.Data())) {
      KJ_IF_MAYBE(schema, Wrapper::unwrap<capnp::ParsedSchema>(args[1])) {
        if (!schema->getProto().isInterface()) {
          v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(
              "Not an interface type: ", schema->getProto().getDisplayName()).cStr())));
          return v8::Handle<v8::Value>();
        }

        RpcClient* self = ObjectWrap::Unwrap<RpcClient>(args.Holder());
        auto ref = toKjString(args[0]);

        capnp::Capability::Client client = self->connectPromise.addBranch()
            .then(kj::mvCapture(ref, [self](kj::String&& ref, kj::Own<RpcConnection>&& connection) {
          return connection->import(ref);
        }));

        capnp::DynamicCapability::Client dynamicClient =
            client.castAs<capnp::DynamicCapability>(schema->asInterface());

        CapClient* adapter = new CapClient(kj::mv(dynamicClient));
        return scope.Close(adapter->wrap(*context, args.Data(), args.Holder()));
      }
    }
    // Exception already thrown.
    return v8::Handle<v8::Value>();
  }
};

void init(v8::Handle<v8::Object> exports) {
  v8::HandleScope scope;
  CapnpContext* context = new CapnpContext;
  auto wrappedContext = context->wrapper.wrap(context);

  context->rpcClientTpl = RpcClient::makeTemplate(wrappedContext);

  exports->Set(v8::String::NewSymbol("import"),
      v8::FunctionTemplate::New(import, wrappedContext)->GetFunction());
  exports->Set(v8::String::NewSymbol("RpcClient"), context->rpcClientTpl->GetFunction());
}

}  // namespace

NODE_MODULE(capnp, init)
