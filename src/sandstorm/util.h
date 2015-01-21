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

#ifndef SANDSTORM_UTIL_H_
#define SANDSTORM_UTIL_H_

#include <kj/io.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <kj/debug.h>

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

typedef unsigned int uint;

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode = 0666);

kj::Maybe<kj::AutoCloseFd> raiiOpenIfExists(
    kj::StringPtr name, int flags, mode_t mode = 0666);

kj::Maybe<kj::String> readLine(kj::BufferedInputStream& input);

class StructyMessage {
  // Helper for constructing a message to be passed to the kernel composed of a bunch of structs
  // back-to-back.

public:
  explicit StructyMessage(uint alignment = 8): alignment(alignment) {
    memset(bytes, 0, sizeof(bytes));
  }

  template <typename T>
  T* add() {
    T* result = reinterpret_cast<T*>(pos);
    pos += (sizeof(T) + (alignment - 1)) & ~(alignment - 1);
    KJ_ASSERT(pos - bytes <= sizeof(bytes));
    return result;
  }

  void addString(const char* data) {
    addBytes(data, strlen(data));
  }
  void addBytes(const void* data, size_t size) {
    memcpy(pos, data, size);
    pos += (size + (alignment - 1)) & ~(alignment - 1);
  }

  void* begin() { return bytes; }
  void* end() { return pos; }
  size_t size() { return pos - bytes; }

private:
  char bytes[4096];
  char* pos = bytes;
  uint alignment;
};

inline size_t offsetBetween(void* start, void* end) {
  return reinterpret_cast<char*>(end) - reinterpret_cast<char*>(start);
}

}  // namespace sandstorm

#endif // SANDSTORM_UTIL_H_
