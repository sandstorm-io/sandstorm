// Hacky node.js bindings for Cap'n Proto.
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm API, which is licensed as follows.
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

#if __cplusplus >= 201300
// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.
#endif

#include <node.h>
#include <node_buffer.h>
#include <capnp/dynamic.h>
#include <capnp/schema-parser.h>
#include <kj/debug.h>
#include <uv.h>
#include <kj/async.h>
#include <kj/async-io.h>
#include <kj/vector.h>
#include <errno.h>
#include <unistd.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <capnp/serialize.h>
#include <unordered_map>
#include <inttypes.h>
#include <set>
#include <stdlib.h>

#include <typeinfo>
#include <typeindex>
#include <cxxabi.h>

namespace v8capnp {
namespace {  // so we get warnings if anything declared in this file is left undefined...

typedef unsigned char byte;
typedef unsigned int uint;

// =======================================================================================
// KJ <-> libuv glue.

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
    if (!stopped) {
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
    if (stopped) return kj::READY_NOW;

    KJ_REQUIRE(readable == nullptr, "Must wait for previous event to complete.");

    auto paf = kj::newPromiseAndFulfiller<void>();
    readable = kj::mv(paf.fulfiller);

    int flags = UV_READABLE | (writable == nullptr ? 0 : UV_WRITABLE);
    UV_CALL(uv_poll_start(&uvPoller, flags, &pollCallback), uvLoop);

    return kj::mv(paf.promise);
  }

  kj::Promise<void> onWritable() {
    if (stopped) return kj::READY_NOW;

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
  bool stopped = false;
  uv_poll_t uvPoller;

  static void pollCallback(uv_poll_t* handle, int status, int events) {
    reinterpret_cast<OwnedFileDescriptor*>(handle->data)->pollDone(status, events);
  }

  void pollDone(int status, int events) {
    if (status != 0) {
      // Error.  libuv produces a non-zero status if polling produced POLLERR.  The error code
      // reported by libuv is always EBADF, even if the file descriptor is perfectly legitimate but
      // has simply become disconnected.  Instead of throwing an exception, we'd rather report
      // that the fd is now readable/writable and let the caller discover the error when they
      // actually attempt to read/write.
      KJ_IF_MAYBE(r, readable) {
        r->get()->fulfill();
        readable = nullptr;
      }
      KJ_IF_MAYBE(w, writable) {
        w->get()->fulfill();
        writable = nullptr;
      }

      // libuv automatically performs uv_poll_stop() before calling poll_cb with an error status.
      stopped = true;

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

    return onWritable().then([=]() {
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
// KJ <-> v8 glue

class EmptyHandle {
public:
  template <typename T>
  inline operator v8::Handle<T>() const {
    return v8::Handle<T>();
  }
  template <typename T>
  inline operator v8::Local<T>() const {
    return v8::Local<T>();
  }
};
static constexpr EmptyHandle emptyHandle = EmptyHandle();

kj::String typeName(const std::type_info& type) {
  int status;
  char* buf = abi::__cxa_demangle(type.name(), nullptr, nullptr, &status);
  kj::String result = kj::heapString(buf == nullptr ? type.name() : buf);
  free(buf);
  return kj::mv(result);
}

#define KJV8_TYPE_ERROR(name, type) \
  return throwTypeError(#name, typeid(type), __func__, __FILE__, __LINE__)

template <typename T>
class OwnHandle {
  // A v8 persistent handle with C++11 move semantics and RAII.

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

#define KJV8_STACK_STR(name, handle, sizeHint) \
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

v8::Local<v8::Value> toJsException(kj::Exception&& exception) {
  v8::Local<v8::Value> result = v8::Exception::Error(
      v8::String::New(exception.getDescription().cStr()));

  if (result->IsObject()) {
    v8::Object* obj = v8::Object::Cast(*result);

    obj->Set(v8::String::NewSymbol("cppFile"), v8::String::New(exception.getFile()));
    obj->Set(v8::String::NewSymbol("line"), v8::Int32::New(exception.getLine()));

    const char* nature = "unknown";
    switch (exception.getNature()) {
      case kj::Exception::Nature::PRECONDITION   : nature = "precondition"  ; break;
      case kj::Exception::Nature::LOCAL_BUG      : nature = "localBug"      ; break;
      case kj::Exception::Nature::OS_ERROR       : nature = "osError"       ; break;
      case kj::Exception::Nature::NETWORK_FAILURE: nature = "networkFailure"; break;
      case kj::Exception::Nature::OTHER          : nature = "other"         ; break;
    }
    obj->Set(v8::String::NewSymbol("nature"), v8::String::NewSymbol(nature));

    const char* durability = "unknown";
    switch (exception.getDurability()) {
      case kj::Exception::Durability::PERMANENT : durability = "permanent" ; break;
      case kj::Exception::Durability::TEMPORARY : durability = "temporary" ; break;
      case kj::Exception::Durability::OVERLOADED: durability = "overloaded"; break;
    }
    obj->Set(v8::String::NewSymbol("durability"), v8::String::NewSymbol(durability));
  } else {
    KJ_LOG(WARNING, "v8 exception is not an object?");
  }

  return result;
}

kj::Exception fromJsException(v8::Handle<v8::Value> exception) {
  // TODO(soon):  Check for "nature", "durability", etc. fields and use them to construct the
  // exception.
  return kj::Exception(
        kj::Exception::Nature::OTHER,
        kj::Exception::Durability::PERMANENT,
        __FILE__, __LINE__, toKjString(exception));
}

EmptyHandle throwTypeError(kj::StringPtr name, const std::type_info& type,
                           const char* func, const char* file, int line) {
  kj::Exception exception(
      kj::Exception::Nature::PRECONDITION, kj::Exception::Durability::PERMANENT,
      file, line,
      kj::str(func, "(): Type error in parameter '", name, "'; expected type: ", typeName(type)));
  v8::ThrowException(toJsException(kj::mv(exception)));
  return emptyHandle;
}

template <typename Func>
v8::Local<v8::Value> liftKj(Func&& func) {
  // Lifts KJ code into V8 code:  Catches exceptions and manages HandleScope.  Don't forget to
  // return the result.

  v8::HandleScope scope;
  v8::Handle<v8::Value> result;
  KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
    result = func();
  })) {
    v8::ThrowException(toJsException(kj::mv(*exception)));
    return emptyHandle;
  } else {
    return scope.Close(result);
  }
}

template <typename T>
struct Wrapped {
  T& value;
  v8::Local<v8::Object> wrapper;
};

class Wrapper {
  // Wraps C++ objects in v8 handles, assigning an appropriate type name and allowing for
  // type-checked unwrapping.

public:
  Wrapper() {
    v8::HandleScope scope;
  }

  template <typename T>
  v8::Local<v8::Object> wrap(T* ptr) {
    const std::type_info& type = typeid(T);
    auto& slot = templates[std::type_index(type)];
    if (slot == nullptr) {
      slot = v8::FunctionTemplate::New();
      slot->InstanceTemplate()->SetInternalFieldCount(2);

      // TODO(someday):  Make stuff work with -fno-rtti?  node itself is compiled without RTTI...
      int status;
      char* buf = abi::__cxa_demangle(type.name(), nullptr, nullptr, &status);
      slot->SetClassName(v8::String::New(buf == nullptr ? type.name() : buf));
      free(buf);
    }

    v8::Local<v8::Object> obj = slot->GetFunction()->NewInstance();
    obj->SetPointerInInternalField(0, const_cast<std::type_info*>(&typeid(T)));
    obj->SetPointerInInternalField(1, ptr);
    v8::Persistent<v8::Object>::New(obj)
        .MakeWeak(reinterpret_cast<void*>(ptr), deleteAttachment<T>);
    return obj;
  }

  template <typename T>
  v8::Local<v8::Object> wrapCopy(T&& value) {
    return wrap(new kj::Decay<T>(kj::fwd<T>(value)));
  }

  template <typename T>
  static kj::Maybe<T&> tryUnwrap(v8::Handle<v8::Value> hdl) {
    if (!hdl->IsObject()) return nullptr;

    v8::Handle<v8::Object> obj(v8::Object::Cast(*hdl));

    if (obj->InternalFieldCount() != 2 ||
        obj->GetPointerFromInternalField(0) != &typeid(T)) {
      v8::Handle<v8::Value> native = obj->GetHiddenValue(v8::String::NewSymbol("capnp::native"));
      if (native.IsEmpty() || native->IsUndefined()) {
        return nullptr;
      } else {
        return tryUnwrap<T>(native);
      }
    } else {
      return *reinterpret_cast<T*>(obj->GetPointerFromInternalField(1));
    }
  }

  template <typename T>
  static kj::Maybe<T&> unwrap(v8::Handle<v8::Value> hdl) {
    KJ_IF_MAYBE(result, tryUnwrap<T>(hdl)) {
      return *result;
    } else {
      kj::Exception exception(
            kj::Exception::Nature::PRECONDITION, kj::Exception::Durability::PERMANENT,
            __FILE__, __LINE__,
            kj::str("Type error (in Cap'n Proto glue).  Expected: ", typeid(T).name()));
      v8::ThrowException(v8::Exception::TypeError(
          v8::String::New(kj::str(exception).cStr())));
      return nullptr;
    }
  }

private:
  std::unordered_map<std::type_index, OwnHandle<v8::FunctionTemplate>> templates;

  template <typename T>
  static void deleteAttachment(v8::Persistent<v8::Value> object, void* ptr) {
    object.Dispose();
    delete reinterpret_cast<T*>(ptr);
  }
};

#define KJV8_UNWRAP(type, name, exp) \
  auto name##_maybe = Wrapper::tryUnwrap<type>(exp); \
  if (name##_maybe == nullptr) KJV8_TYPE_ERROR(name, type); \
  type& name = KJ_ASSERT_NONNULL(name##_maybe)

kj::Maybe<kj::ArrayPtr<const byte>> unwrapBuffer(v8::Handle<v8::Value> value) {
  if (!node::Buffer::HasInstance(value)) {
    return nullptr;
  }

  return kj::arrayPtr<const byte>(reinterpret_cast<byte*>(node::Buffer::Data(value)),
                                  node::Buffer::Length(value));
}

#define KJV8_UNWRAP_BUFFER(name, exp) \
  auto name##_maybe = unwrapBuffer(exp); \
  if (name##_maybe == nullptr) KJV8_TYPE_ERROR(name, kj::Array<byte>); \
  kj::ArrayPtr<const byte>& name = KJ_ASSERT_NONNULL(name##_maybe)

template <typename T>
void deleteArray(char*, void* hint) {
  delete reinterpret_cast<kj::Array<T>*>(hint);
}

template <typename T>
v8::Handle<v8::Value> wrapBuffer(kj::Array<T>&& array) {
  char* data = reinterpret_cast<char*>(array.begin());
  size_t size = array.size() * sizeof(T);
  return node::Buffer::New(data, size, &deleteArray<T>, new kj::Array<T>(kj::mv(array)))->handle_;
}

// =======================================================================================
// Cap'n Proto bindings

struct CapnpContext {
  // Shared context initialized when the module starts up.  This gets passed to each function as
  // the "data".

  UvLowLevelAsyncIoProvider llaiop;
  kj::Own<kj::AsyncIoProvider> aiop;
  capnp::SchemaParser parser;
  Wrapper wrapper;

  std::unordered_map<uint64_t, OwnHandle<v8::Object>> importedFiles;
  // Maps file IDs -> schema tree for that file.

  std::unordered_map<uint64_t, OwnHandle<v8::Object>> methodSets;
  // Maps interface type ID -> object mapping method names to method schemas for that type.

  kj::Vector<kj::Array<kj::String>> searchPaths;
  kj::Vector<kj::Array<kj::StringPtr>> searchPathPtrs;

  CapnpContext()
    : llaiop(uv_default_loop()),
      aiop(kj::newAsyncIoProvider(llaiop)) {}
};

v8::Handle<v8::Value> setNative(const v8::Arguments& args) {
  // setNative(object, nativeHandle)
  //
  // Allows `object` to be passed into this module's functions where `nativeHandle` is expected,
  // without giving Javascript users of `object` access to `nativeHandle`.  This in particular
  // allows a capability wrapper defined in Javascript to be used to represent capabilities fields
  // passed to fromJs().

  if (args[0]->IsObject()) {
    v8::Object::Cast(*args[0])->SetHiddenValue(v8::String::NewSymbol("capnp::native"), args[1]);
  }
  return emptyHandle;
}

v8::Local<v8::Object> schemaToObject(capnp::ParsedSchema schema, CapnpContext& context,
                                     v8::Handle<v8::Value> wrappedContext) {
  auto result = context.wrapper.wrap(new capnp::Schema(schema));

  for (auto nested: schema.getProto().getNestedNodes()) {
    kj::StringPtr name = nested.getName();
    result->Set(v8::String::NewSymbol(name.cStr()),
                schemaToObject(schema.getNested(name), context, wrappedContext));
  }

  return result;
}

v8::Handle<v8::Value> import(const v8::Arguments& args) {
  // import(displayName, diskPath, searchPath) -> schema
  //
  // Parses the schema file at the given path.  See capnp::SchemaParser::parseDiskFile().
  //
  // The returned schema is an object with members corresponding to nested schemas.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_STACK_STR(displayName, args[0], 128);
  KJV8_STACK_STR(diskPath, args[1], 128);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    kj::Array<kj::String> searchPath;
    kj::Array<kj::StringPtr> searchPathPtrs;
    if (!args[2]->IsUndefined()) {
      if (!args[2]->IsArray()) {
        v8::ThrowException(v8::Exception::TypeError(v8::String::New("Search path must be array.")));
        return emptyHandle;
      }

      v8::Array* arr = v8::Array::Cast(*args[2]);
      searchPath = kj::heapArray<kj::String>(arr->Length());
      searchPathPtrs = kj::heapArray<kj::StringPtr>(searchPath.size());
      for (uint i: kj::indices(searchPath)) {
        searchPath[i] = toKjString(arr->Get(i)->ToString());
        searchPathPtrs[i] = searchPath[i];
      }
    }

    capnp::ParsedSchema schema = context.parser.parseDiskFile(
        displayName, diskPath, searchPathPtrs);
    auto& slot = context.importedFiles[schema.getProto().getId()];
    if (slot == nullptr) {
      slot = schemaToObject(schema, context, args.Data());

      // We need to make sure our search paths are never deleted...
      context.searchPaths.add(kj::mv(searchPath));
      context.searchPathPtrs.add(kj::mv(searchPathPtrs));
    }
    return slot.get();
  });
}

void enumerateMethods(capnp::InterfaceSchema schema, v8::Handle<v8::Object> methodMap,
                      CapnpContext& context, std::set<uint64_t>& seen) {
  auto proto = schema.getProto();
  if (seen.insert(proto.getId()).second) {
    for (uint64_t superId: proto.getInterface().getExtends()) {
      enumerateMethods(schema.getDependency(superId).asInterface(), methodMap, context, seen);
    }

    auto methods = schema.getMethods();
    for (auto method: methods) {
      methodMap->Set(v8::String::NewSymbol(method.getProto().getName().cStr()),
                     context.wrapper.wrapCopy(method));
    }
  }
}

v8::Handle<v8::Value> methods(const v8::Arguments& args) {
  // methods(schema) -> {name: method}
  //
  // Given an interface schema, returns the list of methods.  The returned list is memoized.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::Schema, schema, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    auto proto = schema.getProto();
    if (!proto.isInterface()) {
      v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(
          "Not an interface type: ", schema.getProto().getDisplayName()).cStr())));
      return v8::Handle<v8::Value>();
    }

    auto& slot = context.methodSets[proto.getId()];
    if (slot == nullptr) {
      slot = v8::Object::New();
      std::set<uint64_t> seen;
      enumerateMethods(schema.asInterface(), slot.get(), context, seen);
    }

    return slot.get();
  });
}

struct StructBuilder {
  capnp::MallocMessageBuilder message;
  capnp::DynamicStruct::Builder root;

  explicit StructBuilder(capnp::StructSchema schema)
      : root(message.getRoot<capnp::DynamicStruct>(schema)) {}
  explicit StructBuilder(capnp::DynamicStruct::Reader reader)
      : root(nullptr) {
    message.setRoot(reader);
    root = message.getRoot<capnp::DynamicStruct>(reader.getSchema());
  }
};

struct ServerResults: public kj::Refcounted {
  kj::Maybe<capnp::DynamicStruct::Builder> builder;
  // Becomes null when call returns.
};

kj::Maybe<capnp::DynamicStruct::Builder> unwrapBuilder(v8::Handle<v8::Value> handle) {
  // We accept either StructBuilder or Request<DynamicStruct, DynamicStruct>.
  typedef capnp::Request<capnp::DynamicStruct, capnp::DynamicStruct> Request;
  capnp::DynamicStruct::Builder builder;
  KJ_IF_MAYBE(request, Wrapper::tryUnwrap<Request>(handle)) {
    return *request;
  } else KJ_IF_MAYBE(builder, Wrapper::tryUnwrap<StructBuilder>(handle)) {
    return builder->root;
  } else KJ_IF_MAYBE(results, Wrapper::tryUnwrap<kj::Own<ServerResults>>(handle)) {
    return results->get()->builder;
  } else {
    return nullptr;
  }
}

#define KJV8_UNWRAP_BUILDER(name, exp) \
  auto name##_maybe = unwrapBuilder(exp); \
  if (name##_maybe == nullptr) KJV8_TYPE_ERROR(name, capnp::DynamicStruct::Builder); \
  capnp::DynamicStruct::Builder& name = KJ_ASSERT_NONNULL(name##_maybe)

struct StructReader {
  capnp::FlatArrayMessageReader message;
  capnp::DynamicStruct::Reader root;

  StructReader(kj::ArrayPtr<const capnp::word> data, capnp::StructSchema schema)
      : message(data), root(message.getRoot<capnp::DynamicStruct>(schema)) {}
};

struct ServerRequest {
  kj::Own<kj::PromiseFulfiller<void>> fulfiller;
  // Fulfill to complete the call.  You must null out the pointers below, as well as
  // results->builder, when you do.

  kj::Maybe<capnp::CallContext<capnp::DynamicStruct, capnp::DynamicStruct>> context;
  // Becomes null when call returns.

  kj::Maybe<capnp::DynamicStruct::Reader> params;
  // Becomes null when params are released or call returns.

  kj::Maybe<kj::Own<ServerResults>> results;
  // Becomes non-null when getResults() is first called.  Subsequent calls return the same object.
};

kj::Maybe<capnp::DynamicStruct::Reader> unwrapReader(v8::Handle<v8::Value> handle) {
  // We accept any builder as well as Response<DynamicStruct>.
  typedef capnp::Response<capnp::DynamicStruct> Response;
  KJ_IF_MAYBE(response, Wrapper::tryUnwrap<Response>(handle)) {
    return *response;
  } else KJ_IF_MAYBE(reader, Wrapper::tryUnwrap<StructReader>(handle)) {
    return reader->root;
  } else KJ_IF_MAYBE(request, Wrapper::tryUnwrap<ServerRequest>(handle)) {
    return request->params;
  } else KJ_IF_MAYBE(builder, unwrapBuilder(handle)) {
    return builder->asReader();
  } else {
    return nullptr;
  }
}

#define KJV8_UNWRAP_READER(name, exp) \
  auto name##_maybe = unwrapReader(exp); \
  if (name##_maybe == nullptr) KJV8_TYPE_ERROR(name, capnp::DynamicStruct::Reader); \
  capnp::DynamicStruct::Reader& name = KJ_ASSERT_NONNULL(name##_maybe)

v8::Handle<v8::Value> newBuilder(const v8::Arguments& args) {
  // newBuilder(schema) -> builder
  //
  // Given a struct schema, returns a new builder for that type (backed by MallocMessageBuilder).

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::Schema, schema, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    if (!schema.getProto().isStruct()) {
      v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(
          "Not a struct type: ", schema.getProto().getDisplayName()).cStr())));
      return v8::Handle<v8::Value>();
    }

    return context.wrapper.wrap(new StructBuilder(schema.asStruct()));
  });
}

v8::Handle<v8::Value> copyBuilder(const v8::Arguments& args) {
  // copyBuilder(schema) -> builder
  //
  // Copy the contents of a builder or reader into a new builder.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP_READER(reader, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return context.wrapper.wrap(new StructBuilder(reader));
  });
}

v8::Handle<v8::Value> structToString(const v8::Arguments& args) {
  // structToString(builder OR reader) -> String
  //
  // Converts a struct builder or reader (or request or response) to a human-readable string
  // based on Cap'n Proto text format.

  KJV8_UNWRAP_READER(reader, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return v8::String::New(kj::str(reader.getSchema().getProto().getDisplayName(), reader).cStr());
  });
}

// -----------------------------------------------------------------------------

struct FromJsConverter {
  CapnpContext& context;
  v8::Handle<v8::Value> contextHandle;
  v8::Handle<v8::Function> localCapType;

  capnp::DynamicCapability::Client fromLocalCap(
      capnp::InterfaceSchema schema, v8::Handle<v8::Object> object);

  capnp::Orphan<capnp::DynamicValue> int64FromJs(v8::Handle<v8::Value> js) {
    if (js->IsNumber()) {
      return js->IntegerValue();
    } else {
      KJV8_STACK_STR(text, js, 32);
      char* end;
      int64_t result = strtoll(text.cStr(), &end, 0);
      if (text.size() == 0 || *end != '\0') {
        return js->IntegerValue();
      } else {
        return result;
      }
    }
  }

  capnp::Orphan<capnp::DynamicValue> uint64FromJs(v8::Handle<v8::Value> js) {
    if (js->IsNumber()) {
      return js->IntegerValue();
    } else {
      KJV8_STACK_STR(text, js, 32);
      char* end;
      uint64_t result = strtoull(text.cStr(), &end, 0);
      if (text.size() == 0 || *end != '\0') {
        return js->IntegerValue();
      } else {
        return result;
      }
    }
  }

  capnp::Orphan<capnp::DynamicValue> orphanFromJs(
      capnp::StructSchema::Field field, capnp::Orphanage orphanage,
      capnp::schema::Type::Reader type, v8::Handle<v8::Value> js) {
    switch (type.which()) {
      case capnp::schema::Type::VOID:
        // Accept any false-y value.
        if (!js->BooleanValue()) {
          return capnp::VOID;
        }
        break;
      case capnp::schema::Type::BOOL:    return js->BooleanValue();
      case capnp::schema::Type::INT8:    return js->IntegerValue();
      case capnp::schema::Type::INT16:   return js->IntegerValue();
      case capnp::schema::Type::INT32:   return js->IntegerValue();
      case capnp::schema::Type::INT64:   return int64FromJs(js);
      case capnp::schema::Type::UINT8:   return js->IntegerValue();
      case capnp::schema::Type::UINT16:  return js->IntegerValue();
      case capnp::schema::Type::UINT32:  return js->IntegerValue();
      case capnp::schema::Type::UINT64:  return uint64FromJs(js);
      case capnp::schema::Type::FLOAT32: return js->NumberValue();
      case capnp::schema::Type::FLOAT64: return js->NumberValue();
      case capnp::schema::Type::TEXT: {
        v8::HandleScope scope;
        auto str = js->ToString();
        capnp::Orphan<capnp::Text> orphan = orphanage.newOrphan<capnp::Text>(str->Utf8Length());
        str->WriteUtf8(orphan.get().begin());
        return kj::mv(orphan);
      }
      case capnp::schema::Type::DATA:
        KJ_IF_MAYBE(buf, unwrapBuffer(js)) {
          return orphanage.newOrphanCopy(capnp::Data::Reader(*buf));
        }
        break;
      case capnp::schema::Type::LIST: {
        if (js->IsArray()) {
          v8::Array* jsArray = v8::Array::Cast(*js);
          auto elementType = type.getList().getElementType();
          auto schema = capnp::ListSchema::of(elementType, field.getContainingStruct());
          auto orphan = orphanage.newOrphan(schema, jsArray->Length());
          auto builder = orphan.get();
          if (elementType.isStruct()) {
            // Struct lists can't adopt.
            bool error = false;
            for (uint i: kj::indices(builder)) {
              auto element = jsArray->Get(i);
              if (element->IsObject()) {
                if (!structFromJs(builder[i].as<capnp::DynamicStruct>(),
                                  v8::Object::Cast(*element))) {
                  return nullptr;
                }
              } else {
                error = true;
                break;
              }
            }
            if (error) break;
          } else {
            for (uint i: kj::indices(builder)) {
              auto element = orphanFromJs(field, orphanage, elementType, jsArray->Get(i));
              if (element.getType() == capnp::DynamicValue::UNKNOWN) {
                return nullptr;
              }
              builder.adopt(i, kj::mv(element));
            }
          }
          return kj::mv(orphan);
        }
        break;
      }
      case capnp::schema::Type::ENUM: {
        v8::HandleScope scope;  // for string conversion
        KJV8_STACK_STR(name, js, 32);
        auto schema = field.getContainingStruct().getDependency(type.getEnum().getTypeId()).asEnum();
        KJ_IF_MAYBE(enumerant, schema.findEnumerantByName(name)) {
          return capnp::DynamicEnum(*enumerant);
        } else if (js->IsUint32()) {
          return capnp::DynamicEnum(schema, js->Uint32Value());
        }
        break;
      }
      case capnp::schema::Type::STRUCT: {
        KJ_IF_MAYBE(reader, unwrapReader(js)) {
          return orphanage.newOrphanCopy(*reader);
        } else if (js->IsObject()) {
          auto schema = field.getContainingStruct().getDependency(
              type.getStruct().getTypeId()).asStruct();
          auto orphan = orphanage.newOrphan(schema);
          if (!structFromJs(orphan.get(), v8::Object::Cast(*js))) {
            return nullptr;
          }
          return kj::mv(orphan);
        }
      }
      case capnp::schema::Type::INTERFACE: {
        auto schema = field.getContainingStruct().getDependency(
            type.getInterface().getTypeId()).asInterface();
        if (js->IsNull()) {
          auto cap = capnp::Capability::Client(nullptr)
              .castAs<capnp::DynamicCapability>(schema);
          return orphanage.newOrphanCopy(cap);
        } else KJ_IF_MAYBE(cap, Wrapper::tryUnwrap<capnp::DynamicCapability::Client>(js)) {
          return orphanage.newOrphanCopy(*cap);
        } else if (!localCapType.IsEmpty()) {
          v8::Handle<v8::Value> arg = js;
          auto wrapped = localCapType->NewInstance(1, &arg);
          if (!wrapped.IsEmpty()) {
            auto cap = fromLocalCap(schema, wrapped);
            return orphanage.newOrphanCopy(cap);
          }
        }
        break;
      }
      case capnp::schema::Type::ANY_POINTER:
        KJ_IF_MAYBE(reader, unwrapReader(js)) {
          return orphanage.newOrphanCopy(*reader);
        } else KJ_IF_MAYBE(buffer, unwrapBuffer(js)) {
          kj::Array<capnp::word> scratch;
          kj::ArrayPtr<const capnp::word> words;
          if (reinterpret_cast<uintptr_t>(buffer->begin()) % sizeof(capnp::word) != 0) {
            // Array is not aligned.  We have to make a copy.  :(
            scratch = kj::heapArray<capnp::word>(buffer->size() / sizeof(capnp::word));
            memcpy(scratch.begin(), buffer->begin(), buffer->size());
            words = scratch;
          } else {
            // Yay, array is aligned.
            words = kj::arrayPtr(reinterpret_cast<const capnp::word*>(buffer->begin()),
                                 buffer->size() / sizeof(capnp::word));
          }
          capnp::FlatArrayMessageReader reader(words);
          return orphanage.newOrphanCopy(reader.getRoot<capnp::AnyPointer>());
        }
        break;
    }

    v8::ThrowException(v8::Exception::TypeError(v8::String::New(
        kj::str("Type error in field: ", field.getProto().getName()).cStr())));
    return nullptr;
  }

  bool fieldFromJs(capnp::DynamicStruct::Builder builder, capnp::StructSchema::Field field,
                   v8::Handle<v8::Value> js) {
    auto proto = field.getProto();
    switch (proto.which()) {
      case capnp::schema::Field::SLOT: {
        capnp::Orphan<capnp::DynamicValue> value = orphanFromJs(field,
            capnp::Orphanage::getForMessageContaining(builder), proto.getSlot().getType(), js);
        if (value.getType() == capnp::DynamicValue::UNKNOWN) {
          return false;
        }
        builder.adopt(field, kj::mv(value));
        return true;
      }

      case capnp::schema::Field::GROUP:
        if (js->IsObject()) {
          return structFromJs(builder.init(field).as<capnp::DynamicStruct>(),
                              v8::Object::Cast(*js));
        } else {
          v8::ThrowException(v8::Exception::TypeError(v8::String::New(
              kj::str("Type error in field: ", proto.getName()).cStr())));
          return false;
        }
    }

    KJ_FAIL_ASSERT("Unimplemented field type (not slot or group).");
  }

  bool structFromJs(capnp::DynamicStruct::Builder builder, v8::Object* js) {
    v8::HandleScope scope;
    auto schema = builder.getSchema();
  //  for (auto field: schema.getFields()) {
  //    kj::StringPtr name = field.getProto().getName();
  //    v8::Handle<v8::Value> value = js->Get(v8::String::NewSymbol(name.begin(), name.size()));
  //    if (!value.IsEmpty() && !value->IsUndefined()) {
  //      fieldFromJs(builder, field, value);
  //    }
  //  }
    v8::Local<v8::Array> fieldNames = js->GetPropertyNames();
    for (uint i: kj::range(0u, fieldNames->Length())) {
      auto jsName = fieldNames->Get(i);
      KJV8_STACK_STR(fieldName, jsName, 32);
      KJ_IF_MAYBE(field, schema.findFieldByName(fieldName)) {
        fieldFromJs(builder, *field, js->Get(jsName));
      } else {
        v8::ThrowException(v8::Exception::TypeError(v8::String::New(
            kj::str("No field named: ", fieldName).cStr())));
        return false;
      }
    }
    return true;
  }
};

v8::Handle<v8::Value> fromJs(const v8::Arguments& args) {
  // fromJs(builder, jso, LocalCap) -> void
  //
  // Copies the contents of a JS object into a struct builder.
  //
  // If `jso` is an array, it will be treated as an argument list ordered by ordinal.
  //
  // `LocalCap` is a constructor that takes a JS object as a parameter and produces a new object
  // that would be appropritae to pass to `newCap`.  Normally this means wrapping each method to
  // take an RPC request as its input.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP_BUILDER(builder, args[0]);
  v8::Handle<v8::Value> jsValue = args[1];

  v8::Handle<v8::Function> localCapType = emptyHandle;
  if (args[2]->IsFunction()) {
    localCapType = v8::Handle<v8::Function>(v8::Function::Cast(*args[2]));
  }

  return liftKj([&]() -> v8::Handle<v8::Value> {
    auto schema = builder.getSchema();

    FromJsConverter converter = { context, args.Data(), localCapType };

    if (jsValue->IsArray()) {
      v8::Array* array = v8::Array::Cast(*jsValue);
      auto fields = schema.getFields();
      uint length = kj::min(array->Length(), fields.size());

      for (uint i = 0; i < length; i++) {
        if (!converter.fieldFromJs(builder, fields[i], array->Get(i))) {
          break;
        }
      }
    } else if (jsValue->IsObject()) {
      converter.structFromJs(builder, v8::Object::Cast(*jsValue));
    } else {
      v8::ThrowException(v8::Exception::TypeError(v8::String::New(
          "fromJs() requires an array or an object.")));
    }

    return v8::Undefined();
  });
}

// -----------------------------------------------------------------------------

bool fieldToJs(CapnpContext& context, v8::Handle<v8::Object> object,
               capnp::DynamicStruct::Reader reader, capnp::StructSchema::Field field,
               v8::Handle<v8::Value> capConstructor);

v8::Handle<v8::Value> valueToJs(CapnpContext& context, capnp::DynamicValue::Reader value,
                                capnp::schema::Type::Which whichType,
                                v8::Handle<v8::Value> capConstructor) {
  switch (value.getType()) {
    case capnp::DynamicValue::UNKNOWN:
      return v8::Undefined();
    case capnp::DynamicValue::VOID:
      return v8::Null();
    case capnp::DynamicValue::BOOL:
      return v8::Boolean::New(value.as<bool>());
    case capnp::DynamicValue::INT: {
      if (whichType == capnp::schema::Type::INT64 ||
          whichType == capnp::schema::Type::UINT64) {
        // 64-bit values must be stringified to avoid losing precision.
        return v8::String::New(kj::str(value.as<int64_t>()).cStr());
      } else {
        return v8::Integer::New(value.as<int32_t>());
      }
    }
    case capnp::DynamicValue::UINT: {
      if (whichType == capnp::schema::Type::INT64 ||
          whichType == capnp::schema::Type::UINT64) {
        // 64-bit values must be stringified to avoid losing precision.
        return v8::String::New(kj::str(value.as<uint64_t>()).cStr());
      } else {
        return v8::Integer::NewFromUnsigned(value.as<uint32_t>());
      }
    }
    case capnp::DynamicValue::FLOAT:
      return v8::Number::New(value.as<double>());
    case capnp::DynamicValue::TEXT: {
      capnp::Text::Reader text = value.as<capnp::Text>();
      return v8::String::New(text.begin(), text.size());
    }
    case capnp::DynamicValue::DATA: {
      capnp::Data::Reader data = value.as<capnp::Data>();
      return node::Buffer::New(reinterpret_cast<const char*>(data.begin()), data.size())->handle_;
    }
    case capnp::DynamicValue::LIST: {
      v8::HandleScope scope;
      capnp::DynamicList::Reader list = value.as<capnp::DynamicList>();
      auto elementType = list.getSchema().whichElementType();
      auto array = v8::Array::New(list.size());
      for (uint i: kj::indices(list)) {
        auto subValue = valueToJs(context, list[i], elementType, capConstructor);
        if (subValue.IsEmpty()) {
          return emptyHandle;
        }
        array->Set(i, subValue);
      }
      return scope.Close(array);
    }
    case capnp::DynamicValue::ENUM: {
      auto enumValue = value.as<capnp::DynamicEnum>();
      KJ_IF_MAYBE(enumerant, enumValue.getEnumerant()) {
        return v8::String::NewSymbol(enumerant->getProto().getName().cStr());
      } else {
        return v8::Integer::NewFromUnsigned(enumValue.getRaw());
      }
    }
    case capnp::DynamicValue::STRUCT: {
      v8::HandleScope scope;
      capnp::DynamicStruct::Reader reader = value.as<capnp::DynamicStruct>();
      auto object = v8::Object::New();
      KJ_IF_MAYBE(field, reader.which()) {
        if (!fieldToJs(context, object, reader, *field, capConstructor)) {
          return emptyHandle;
        }
      }

      for (auto field: reader.getSchema().getNonUnionFields()) {
        if (reader.has(field)) {
          if (!fieldToJs(context, object, reader, field, capConstructor)) {
            return emptyHandle;
          }
        }
      }
      return scope.Close(object);
    }
    case capnp::DynamicValue::CAPABILITY: {
      v8::HandleScope scope;
      auto cap = value.as<capnp::DynamicCapability>();
      capnp::Schema schema = cap.getSchema();
      v8::Handle<v8::Value> result = context.wrapper.wrapCopy(kj::mv(cap));
      if (capConstructor->IsFunction()) {
        v8::Function* func = v8::Function::Cast(*capConstructor);
        v8::Handle<v8::Value> args[2] = { result, context.wrapper.wrapCopy(schema) };
        result = func->NewInstance(kj::size(args), args);
        if (result.IsEmpty()) {
          return emptyHandle;
        }
      }
      return scope.Close(result);
    }
    case capnp::DynamicValue::ANY_POINTER:
      // TODO(soon):  How do we represent AnyPointer?
      return v8::Undefined();
  }

  KJ_FAIL_ASSERT("Unimplemented DynamicValue type.");
}

bool fieldToJs(CapnpContext& context, v8::Handle<v8::Object> object,
               capnp::DynamicStruct::Reader reader, capnp::StructSchema::Field field,
               v8::Handle<v8::Value> capConstructor) {
  auto proto = field.getProto();
  v8::Handle<v8::Value> fieldValue;
  switch (proto.which()) {
    case capnp::schema::Field::SLOT:
      fieldValue = valueToJs(context, reader.get(field), proto.getSlot().getType().which(),
                             capConstructor);
      goto setField;
    case capnp::schema::Field::GROUP:
      // Hack:  We don't have a schema::Type instance to use here, but it turns out valueToJs()
      //   doesn't need one when receiving a struct value.  So, uh...  provide a fake one.  :/
      fieldValue = valueToJs(context, reader.get(field), capnp::schema::Type::STRUCT,
                             capConstructor);
      goto setField;
  }

  KJ_FAIL_ASSERT("Unimplemented field type (not slot or group).");

setField:
  if (fieldValue.IsEmpty()) {
    return false;
  } else {
    object->Set(v8::String::NewSymbol(proto.getName().cStr()), fieldValue);
    return true;
  }
}

v8::Handle<v8::Value> toJs(const v8::Arguments& args) {
  // toJs(reader, CapType) -> object
  //
  // Given a struct reader, builds a JS object based on the contents.  If CapType is specified,
  // it is a constructor to use to build wrappers around capabilities in the object.  The
  // constructor will be passed the capability and its schema as parameters.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP_READER(reader, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return valueToJs(context, reader, capnp::schema::Type::STRUCT, args[1]);
  });
}

v8::Handle<v8::Value> toJsParams(const v8::Arguments& args) {
  // toJsParams(reader, CapType) -> array
  //
  // Like toJs(), but interprets the input as a method parameter struct and produces a parameter
  // array from it.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP_READER(reader, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    auto schema = reader.getSchema();
    if (schema.getProto().getScopeId() == 0) {
      // This appears to be a parameter set.
      // (TODO(cleanup):  Detecting this by scope ID seems ugly, but currently there's no other
      // way.)

      auto fields = schema.getFields();
      auto result = v8::Array::New(fields.size());
      for (uint i: kj::indices(fields)) {
        result->Set(i, valueToJs(context, reader.get(fields[i]),
                    capnp::schema::Type::STRUCT, args[1]));
      }
      return result;
    } else {
      auto result = v8::Array::New(1);
      result->Set(1, valueToJs(context, reader, capnp::schema::Type::STRUCT, args[1]));
      return result;
    }
  });
}

// -----------------------------------------------------------------------------

v8::Handle<v8::Value> fromBytes(const v8::Arguments& args) {
  // fromBytes(buffer, schema) -> reader

  KJV8_UNWRAP(CapnpContext, context, args.Data());

  v8::Handle<v8::Value> bufferHandle = args[0];
  KJV8_UNWRAP_BUFFER(buffer, bufferHandle);

  KJV8_UNWRAP(capnp::Schema, schema, args[1]);
  if (!schema.getProto().isStruct()) {
    KJV8_TYPE_ERROR(schema, capnp::StructSchema);
    return emptyHandle;
  }

  return liftKj([&]() -> v8::Handle<v8::Value> {
    kj::ArrayPtr<const capnp::word> words;
    if (reinterpret_cast<uintptr_t>(buffer.begin()) % sizeof(capnp::word) != 0) {
      // Array is not aligned.  We have to make a copy.  :(
      auto array = kj::heapArray<capnp::word>(buffer.size() / sizeof(capnp::word));
      memcpy(array.begin(), buffer.begin(), buffer.size());
      words = array;
      bufferHandle = context.wrapper.wrapCopy(kj::mv(array));
    } else {
      // Yay, array is aligned.
      words = kj::arrayPtr(reinterpret_cast<const capnp::word*>(buffer.begin()),
                           buffer.size() / sizeof(capnp::word));
    }

    auto wrapper = context.wrapper.wrap(new StructReader(words, schema.asStruct()));
    wrapper->SetHiddenValue(v8::String::NewSymbol("buffer"), bufferHandle);
    return wrapper;
  });
}

v8::Handle<v8::Value> toBytes(const v8::Arguments& args) {
  // toBytes(builder) -> buffer

  KJV8_UNWRAP(StructBuilder, builder, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return wrapBuffer(capnp::messageToFlatArray(builder.message));
  });
}

// -----------------------------------------------------------------------------

class RpcConnection: public kj::Refcounted {
  // A two-party RPC connection.

public:
  RpcConnection(kj::Own<kj::AsyncIoStream>&& streamParam)
      : stream(kj::mv(streamParam)),
        network(*stream, capnp::rpc::twoparty::Side::CLIENT),
        rpcSystem(capnp::makeRpcClient(network)) {}

  capnp::Capability::Client import(kj::StringPtr ref) {
    capnp::MallocMessageBuilder builder;
    auto root = builder.getRoot<capnp::rpc::SturdyRef>();
    auto hostId = root.getHostId().initAs<capnp::rpc::twoparty::SturdyRefHostId>();
    hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
    root.getObjectId().setAs<capnp::Text>(ref);

    return rpcSystem.restore(hostId, root.getObjectId());
  }

  capnp::Capability::Client importDefault() {
    capnp::MallocMessageBuilder builder;
    auto root = builder.getRoot<capnp::rpc::SturdyRef>();
    auto hostId = root.getHostId().initAs<capnp::rpc::twoparty::SturdyRefHostId>();
    hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
    return rpcSystem.restore(hostId, root.getObjectId());
  }

  kj::Own<RpcConnection> addRef() {
    return kj::addRef(*this);
  }

  void close() {
    stream->shutdownWrite();
  }

private:
  kj::Own<kj::AsyncIoStream> stream;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::SturdyRefHostId> rpcSystem;
};

struct ConnenctionWrapper {
  kj::ForkedPromise<kj::Own<RpcConnection>> promise;
};

v8::Handle<v8::Value> connect(const v8::Arguments& args) {
  // connect(addr) -> connection
  //
  // Connect to the given address using the two-party protocol.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_STACK_STR(address, args[0], 64);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    auto promise = context.aiop->getNetwork().parseAddress(address)
        .then([](kj::Own<kj::NetworkAddress>&& addr) {
      return addr->connect();
    }).then([](kj::Own<kj::AsyncIoStream>&& stream) {
      return kj::refcounted<RpcConnection>(kj::mv(stream));
    });

    return context.wrapper.wrapCopy(ConnenctionWrapper { promise.fork() });
  });
}

v8::Handle<v8::Value> disconnect(const v8::Arguments& args) {
  // disconnect(connection)
  //
  // Shuts down the connection.

  KJV8_UNWRAP(ConnenctionWrapper, connectionWrapper, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    connectionWrapper.promise.addBranch().then([](kj::Own<RpcConnection>&& connection) {
      connection->close();
    }).detach([](kj::Exception&& e) {
      KJ_LOG(ERROR, e);
    });
    return v8::Undefined();
  });
}

v8::Handle<v8::Value> restore(const v8::Arguments& args) {
  // restore(connection, objectId, schema) -> cap
  //
  // Restore a SturdyRef from the other end of a two-party connection.  objectId may be a string,
  // reader, or builder.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(ConnenctionWrapper, connectionWrapper, args[0]);
  bool isNullRef = args[1]->IsNull();
  auto ref = toKjString(args[1]);  // TODO(soon):  Allow struct reader.
  KJV8_UNWRAP(capnp::Schema, schema, args[2]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    if (!schema.getProto().isInterface()) {
      v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(
          "Not an interface type: ", schema.getProto().getDisplayName()).cStr())));
      return v8::Handle<v8::Value>();
    }

    capnp::Capability::Client client = connectionWrapper.promise.addBranch()
        .then(kj::mvCapture(ref,[isNullRef](kj::String&& ref, kj::Own<RpcConnection>&& connection) {
      return isNullRef ? connection->importDefault() : connection->import(ref);
    }));

    return context.wrapper.wrapCopy(client.castAs<capnp::DynamicCapability>(schema.asInterface()));
  });
}

v8::Handle<v8::Value> castAs(const v8::Arguments& args) {
  // castAs(cap, schema) -> cap
  //
  // Reinterpret the capability as implementing a different interface.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::DynamicCapability::Client, cap, args[0]);
  KJV8_UNWRAP(capnp::Schema, schema, args[1]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    if (!schema.getProto().isInterface()) {
      v8::ThrowException(v8::Exception::Error(v8::String::New(kj::str(
          "Not an interface type: ", schema.getProto().getDisplayName()).cStr())));
      return v8::Handle<v8::Value>();
    }
    return context.wrapper.wrapCopy(cap.castAs<capnp::DynamicCapability>(schema.asInterface()));
  });
}

v8::Handle<v8::Value> schemaFor(const v8::Arguments& args) {
  // schemaFor(cap) -> schema
  //
  // Get the schema for a capability.  Unlike with import(), the returned object does NOT contain
  // nested schemas, though it can be passed to methods() to obtain a method list.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::DynamicCapability::Client, cap, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return context.wrapper.wrapCopy(capnp::Schema(cap.getSchema()));
  });
}

v8::Handle<v8::Value> closeCap(const v8::Arguments& args) {
  // close(cap) -> void
  //
  // Close the capability, discarding the underlying reference.  Doing this explicitly (rather than
  // waiting for GC) allows the other end to more quickly receive notification that it can clean up
  // the object.

  KJV8_UNWRAP(capnp::DynamicCapability::Client, cap, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    // Overwrite with a null cap.
    cap = capnp::Capability::Client(capnp::newBrokenCap("Capability has been closed."))
        .castAs<capnp::DynamicCapability>(cap.getSchema());

    return v8::Undefined();
  });
}

v8::Handle<v8::Value> dupCap(const v8::Arguments& args) {
  // dup(cap) -> cap
  //
  // Return a new reference to the given cap which must be separately close()ed.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::DynamicCapability::Client, cap, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return context.wrapper.wrapCopy(cap);
  });
}

v8::Handle<v8::Value> dup2Cap(const v8::Arguments& args) {
  // dup2(srcCap, dstCap)
  //
  // Overwrite dstCap so that it points to a new reference to srcCap.  The old dstCap is closed.
  // This function is provided mainly so that after a call completes, the pipeline caps can be
  // replaced with their resolved versions, to avoid the need to make the application close()
  // the pipelined caps separately from the final versions.

  KJV8_UNWRAP(capnp::DynamicCapability::Client, srcCap, args[0]);
  KJV8_UNWRAP(capnp::DynamicCapability::Client, dstCap, args[1]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    dstCap = srcCap;
    return v8::Undefined();
  });
}

v8::Handle<v8::Value> request(const v8::Arguments& args) {
  // request(cap, method) -> request (a builder)
  //
  // Start a new request.  Returns the request builder, which can also be passed to send().

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::DynamicCapability::Client, cap, args[0]);
  KJV8_UNWRAP(capnp::InterfaceSchema::Method, method, args[1]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return context.wrapper.wrapCopy(cap.newRequest(method));
  });
}

bool pipelineToJs(CapnpContext& context, capnp::DynamicStruct::Pipeline&& pipeline,
                  v8::Handle<v8::Object> js, v8::Handle<v8::Value> capConstructor);

v8::Handle<v8::Object> pipelineStructFieldToJs(CapnpContext& context,
                                               capnp::DynamicStruct::Pipeline& pipeline,
                                               capnp::StructSchema::Field field,
                                               v8::Handle<v8::Value> capConstructor) {
  v8::Handle<v8::Object> fieldValue = v8::Object::New();
  if (!pipelineToJs(context, pipeline.get(field).releaseAs<capnp::DynamicStruct>(),
                    fieldValue, capConstructor)) {
    return emptyHandle;
  }
  return fieldValue;
}

bool pipelineToJs(CapnpContext& context, capnp::DynamicStruct::Pipeline&& pipeline,
                  v8::Handle<v8::Object> js, v8::Handle<v8::Value> capConstructor) {
  v8::HandleScope scope;
  capnp::StructSchema schema = pipeline.getSchema();

  for (capnp::StructSchema::Field field: schema.getNonUnionFields()) {
    auto proto = field.getProto();
    v8::Handle<v8::Object> fieldValue;

    switch (proto.which()) {
      case capnp::schema::Field::SLOT:
        switch (proto.getSlot().getType().which()) {
          case capnp::schema::Type::STRUCT:
            fieldValue = pipelineStructFieldToJs(context, pipeline, field, capConstructor);
            break;
          case capnp::schema::Type::INTERFACE: {
            auto cap = pipeline.get(field).releaseAs<capnp::DynamicCapability>();
            capnp::Schema capSchema = cap.getSchema();
            fieldValue = context.wrapper.wrapCopy(kj::mv(cap));
            if (!capConstructor->IsUndefined() && capConstructor->IsFunction()) {
              v8::Function* func = v8::Function::Cast(*capConstructor);
              v8::Handle<v8::Value> args[2] = { fieldValue,
                  context.wrapper.wrapCopy(kj::mv(capSchema)) };
              fieldValue = func->NewInstance(kj::size(args), args);
            }
            break;
          }
          default:
            continue;
        }
        break;

      case capnp::schema::Field::GROUP:
        fieldValue = pipelineStructFieldToJs(context, pipeline, field, capConstructor);
        break;

      default:
        continue;
    }

    if (fieldValue.IsEmpty()) {
      return false;
    }
    js->Set(v8::String::NewSymbol(proto.getName().cStr()), fieldValue);
  }

  return true;
}

struct Canceler: public kj::Refcounted {
  kj::Own<kj::PromiseFulfiller<capnp::Response<capnp::DynamicStruct>>> fulfiller;
};

v8::Handle<v8::Value> send(const v8::Arguments& args) {
  // send(request, callback, errorCallback, CapType) -> pipeline tree
  //
  // Send a request and call the callback when done, passing the final result.
  //
  // Calls `errorCallback` if there is an error, passing it an object describing the KJ exception
  // (this is not a JS Error object!).
  //
  // Returns an object tree representing all of the promise's pipelined capabilities.  Be careful:
  // each of these capabilities needs to be close()ed.
  //
  // CapType is the constructor for a capability wrapper; see toJs().

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  typedef capnp::Request<capnp::DynamicStruct, capnp::DynamicStruct> Request;
  KJV8_UNWRAP(Request, request, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    if (!args[1]->IsFunction() || !args[2]->IsFunction()) {
      v8::ThrowException(v8::Exception::TypeError(v8::String::New("Callbacks must be functions.")));
      return emptyHandle;
    }
    OwnHandle<v8::Function> callback = v8::Handle<v8::Function>(v8::Function::Cast(*args[1]));
    OwnHandle<v8::Function> errorCallback = v8::Handle<v8::Function>(v8::Function::Cast(*args[2]));

    auto promise = request.send();

    auto cancelerPaf = kj::newPromiseAndFulfiller<capnp::Response<capnp::DynamicStruct>>();

    auto canceler = kj::refcounted<Canceler>();
    canceler->fulfiller = kj::mv(cancelerPaf.fulfiller);

    v8::Handle<v8::Object> result = context.wrapper.wrapCopy(kj::addRef(*canceler));

    // Wait for results and call the callback.  Note that we can safely capture `context` by
    // reference because if the context is destroyed, the event loop will stop running.
    promise.exclusiveJoin(kj::mv(cancelerPaf.promise))
        .attach(kj::mv(canceler))  // Prevent cancellation from GC.
        .then(kj::mvCapture(callback,
          [&context](OwnHandle<v8::Function>&& callback,
                     capnp::Response<capnp::DynamicStruct>&& response) {
      v8::HandleScope scope;
      v8::Handle<v8::Value> args[1] = { context.wrapper.wrapCopy(kj::mv(response)) };
      // TODO(cleanup):  Call() demands an Object parameter but `undefined` is not an object.  So
      //   we pass an empty object.  Can we do better?
      v8::TryCatch tryCatch;
      callback->Call(v8::Object::New(), 1, args).IsEmpty();
      if (tryCatch.HasCaught()) {
        KJV8_STACK_STR(message, tryCatch.StackTrace(), 512);
        KJ_LOG(ERROR, "Uncaught v8 exception in Cap'n Proto callback.", message);
      }
    })).detach(kj::mvCapture(errorCallback,
          [&context](OwnHandle<v8::Function>&& errorCallback,
                     kj::Exception&& exception) {
      v8::HandleScope scope;
      v8::Handle<v8::Value> args[1] = { toJsException(kj::mv(exception)) };
      v8::TryCatch tryCatch;
      errorCallback->Call(v8::Object::New(), 1, args);
      if (tryCatch.HasCaught()) {
        KJV8_STACK_STR(message, tryCatch.StackTrace(), 512);
        KJ_LOG(ERROR, "Uncaught v8 exception in Cap'n Proto callback.", message);
      }
    }));

    if (!pipelineToJs(context, kj::mv(promise), result, args[3])) {
      return emptyHandle;
    }
    return result;
  });
}

v8::Handle<v8::Value> cancel(const v8::Arguments& args) {
  // cancel(pipeline) -> void
  //
  // Request cancellation of the given RPC.  If the RPC hasn't completed yet, it will be canceled
  // and errorCallback will be called with an appropriate error.  Note that `callback` could still
  // be called after cancel(), if it was already queued in the event loop at time of cancellation.

  KJV8_UNWRAP(kj::Own<Canceler>, canceler, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    canceler->fulfiller->reject(kj::Exception(
        kj::Exception::Nature::OTHER,
        kj::Exception::Durability::PERMANENT,
        __FILE__, __LINE__, kj::heapString("Request canceled by caller.")));
    return v8::Undefined();
  });
}

// -----------------------------------------------------------------------------
// Local caps

class LocalCap final: public capnp::DynamicCapability::Server {
public:
  LocalCap(capnp::InterfaceSchema schema, v8::Handle<v8::Object> object,
           CapnpContext& capnpContext, v8::Handle<v8::Value> capnpContextHandle)
      : capnp::DynamicCapability::Server(schema),
        object(object), capnpContext(capnpContext), capnpContextHandle(capnpContextHandle) {}

  kj::Promise<void> call(capnp::InterfaceSchema::Method method,
      capnp::CallContext<capnp::DynamicStruct, capnp::DynamicStruct> context) override {
    v8::HandleScope scope;

    auto jsMethod = object->Get(v8::String::NewSymbol(method.getProto().getName().cStr()));

    if (!jsMethod->IsFunction()) {
      auto name = method.getProto().getName();
      KJ_FAIL_ASSERT("Method not implemented.", name) { break; }
      return kj::READY_NOW;
    }
    auto func = v8::Function::Cast(*jsMethod);

    auto paf = kj::newPromiseAndFulfiller<void>();

    ServerRequest request;
    request.fulfiller = kj::mv(paf.fulfiller);
    request.context = context;
    request.params = context.getParams();

    v8::Handle<v8::Value> arg = capnpContext.wrapper.wrapCopy(kj::mv(request));
    v8::TryCatch tryCatch;
    func->Call(object.get(), 1, &arg);
    if (tryCatch.HasCaught()) {
      return fromJsException(tryCatch.Exception());
    } else {
      return kj::mv(paf.promise);
    }
  }

private:
  OwnHandle<v8::Object> object;
  CapnpContext& capnpContext;
  OwnHandle<v8::Value> capnpContextHandle;
};

capnp::DynamicCapability::Client FromJsConverter::fromLocalCap(
    capnp::InterfaceSchema schema, v8::Handle<v8::Object> object) {
  return kj::heap<LocalCap>(schema, object, context, contextHandle);
}

v8::Handle<v8::Value> newCap(const v8::Arguments& args) {
  // newCap(schema, obj) -> cap
  //
  // Creates a capability hosted locally.  `obj` is an object mapping method names to methods.
  // Each method takes a ServerRequest (which acts as a Reader, but also has additional methods)
  // as its parameter, and the result is ignored.
  //
  // If `obj` is actually a native cap, this method just returns it.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(capnp::Schema, schema, args[0]);
  if (!schema.getProto().isInterface()) {
    KJV8_TYPE_ERROR(schema, capnp::InterfaceSchema);
  }
  if (!args[1]->IsObject()) {
    KJV8_TYPE_ERROR(obj, v8::Object);
  }

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return context.wrapper.wrapCopy(capnp::DynamicCapability::Client(
        kj::heap<LocalCap>(schema.asInterface(),
                           v8::Handle<v8::Object>(v8::Object::Cast(*args[1])),
                           context, args.Data())));
  });
}

v8::Handle<v8::Value> isCap(const v8::Arguments& args) {
  // isCap(value) -> boolean
  //
  // If `value` is a capability, return true.

  return liftKj([&]() -> v8::Handle<v8::Value> {
    return v8::Boolean::New(
        Wrapper::tryUnwrap<capnp::DynamicCapability::Client>(args[0]) != nullptr);
  });
}

v8::Handle<v8::Value> releaseParams(const v8::Arguments& args) {
  // releaseParams(serverRequest) -> void
  //
  // Release the parameter strurct for the request.  The parameters will appear to be an empty
  // struct if accessed after this call.

  KJV8_UNWRAP(ServerRequest, request, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    KJ_IF_MAYBE(callContext, request.context) {
      request.params = nullptr;
      callContext->releaseParams();
    }
    return v8::Undefined();
  });
}

v8::Handle<v8::Value> getResults(const v8::Arguments& args) {
  // getResults(serverRequest) -> builder
  //
  // Get the results builder for the giver request object.

  KJV8_UNWRAP(CapnpContext, context, args.Data());
  KJV8_UNWRAP(ServerRequest, request, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    kj::Own<ServerResults> results;
    KJ_IF_MAYBE(existing, request.results) {
      results = kj::addRef(**existing);
    } else {
      results = kj::refcounted<ServerResults>();
      request.results = kj::addRef(*results);
      KJ_IF_MAYBE(callContext, request.context) {
        results->builder = callContext->getResults();
      }
    }
    return context.wrapper.wrapCopy(kj::mv(results));
  });
}

v8::Handle<v8::Value> return_(const v8::Arguments& args) {
  // return_(serverRequest) -> void
  //
  // Completes the given request.  getResults() should be used to fill in the results before
  // calling this.  The params and results builders are invalidated after this is called.

  KJV8_UNWRAP(ServerRequest, request, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    request.context = nullptr;
    request.params = nullptr;
    KJ_IF_MAYBE(results, request.results) {
      results->get()->builder = nullptr;
    }
    request.fulfiller->fulfill();
    return v8::Undefined();
  });
}

v8::Handle<v8::Value> throw_(const v8::Arguments& args) {
  // throw_(serverRequest, error) -> void
  //
  // Fail the request with an error (should be a Javascript `Error` object).  The params and
  // results builders are invalidated after this is called.

  KJV8_UNWRAP(ServerRequest, request, args[0]);

  return liftKj([&]() -> v8::Handle<v8::Value> {
    request.context = nullptr;
    request.params = nullptr;
    KJ_IF_MAYBE(results, request.results) {
      results->get()->builder = nullptr;
    }
    request.fulfiller->reject(fromJsException(args[1]));
    return v8::Undefined();
  });
}

// -----------------------------------------------------------------------------

void init(v8::Handle<v8::Object> exports) {
  liftKj([&]() -> v8::Handle<v8::Value> {
    CapnpContext* context = new CapnpContext;
    auto wrappedContext = context->wrapper.wrap(context);

    auto mapFunction = [&](const char* name, v8::InvocationCallback callback) {
      exports->Set(v8::String::NewSymbol(name),
          v8::FunctionTemplate::New(callback, wrappedContext)->GetFunction());
    };

    mapFunction("setNative", setNative);
    mapFunction("import", import);
    mapFunction("methods", methods);
    mapFunction("newBuilder", newBuilder);
    mapFunction("copyBuilder", copyBuilder);
    mapFunction("structToString", structToString);
    mapFunction("fromJs", fromJs);
    mapFunction("toJs", toJs);
    mapFunction("toJsParams", toJsParams);
    mapFunction("fromBytes", fromBytes);
    mapFunction("toBytes", toBytes);
    mapFunction("connect", connect);
    mapFunction("disconnect", disconnect);
    mapFunction("restore", restore);
    mapFunction("castAs", castAs);
    mapFunction("schemaFor", schemaFor);
    mapFunction("close", closeCap);
    mapFunction("dup", dupCap);
    mapFunction("dup2", dup2Cap);
    mapFunction("request", request);
    mapFunction("send", send);
    mapFunction("cancel", cancel);
    mapFunction("newCap", newCap);
    mapFunction("isCap", isCap);
    mapFunction("releaseParams", releaseParams);
    mapFunction("getResults", getResults);
    mapFunction("return_", return_);
    mapFunction("throw_", throw_);

    return emptyHandle;
  });
}

}  // namespace
}  // namespace v8capnp

NODE_MODULE(v8capnp, v8capnp::init)
