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
// This file contains various utility functions used in Sandstorm.
//
// TODO(cleanup): A lot of stuff in here should move into KJ, after proper cleanup.

#include <kj/io.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <kj/debug.h>
#include <kj/vector.h>

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
typedef unsigned char byte;

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode = 0666);
kj::AutoCloseFd raiiOpenAt(int dirfd, kj::StringPtr name, int flags, mode_t mode = 0666);

kj::Maybe<kj::AutoCloseFd> raiiOpenIfExists(
    kj::StringPtr name, int flags, mode_t mode = 0666);
kj::Maybe<kj::AutoCloseFd> raiiOpenAtIfExists(
    int dirfd, kj::StringPtr name, int flags, mode_t mode = 0666);

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

constexpr const char* EXEC_END_ARGS = nullptr;

kj::String trim(kj::ArrayPtr<const char> slice);
kj::ArrayPtr<const char> trimArray(kj::ArrayPtr<const char> slice);
// Remove whitespace from both ends of the char array and return what's left as a String.

void toLower(kj::ArrayPtr<char> text);
// Force entire array of chars to lower-case.

kj::Maybe<uint> parseUInt(kj::StringPtr s, int base);
// Try to parse an integer with strtoul(), return null if parsing fails or doesn't consume all
// input.

kj::AutoCloseFd openTemporary(kj::StringPtr near);
// Creates a temporary file in the same directory as the file specified by "near", immediately
// unlinks it, and then returns the file descriptor,  which will be open for both read and write.

bool isDirectory(kj::StringPtr path);

kj::Array<kj::String> listDirectory(kj::StringPtr dirname);
// Get names of all files in the given directory except for "." and "..".

kj::Array<kj::String> listDirectoryFd(int dirfd);
// Like `listDirectory()` but operates on a file descriptor.

void recursivelyDelete(kj::StringPtr path);
// Delete the given path, recursively if it is a directory.
//
// Since this may be used in KJ_DEFER to delete temporary directories, all exceptions are
// recoverable (won't throw if already unwinding).

kj::String readAll(int fd);
// Read entire contents of the file descirptor to a String.

kj::String readAll(kj::StringPtr name);
// Read entire contents of a named file to a String.

kj::Array<kj::String> splitLines(kj::String input);
// Split the input into lines, trimming whitespace, and ignoring blank lines or lines that start
// with #. Consumes the input string.

kj::Vector<kj::ArrayPtr<const char>> split(kj::ArrayPtr<const char> input, char delim);
// Split the char array on an arbitrary delimiter character.

kj::Maybe<kj::ArrayPtr<const char>> splitFirst(kj::ArrayPtr<const char>& input, char delim);
// Split the char array on the first instance of the delimiter. `input` is updated in-place to
// point at the remainder of the array while the prefix that was split off is returned. If the
// delimiter doesn't appear, returns null.

kj::ArrayPtr<const char> extractHostFromUrl(kj::StringPtr url);
kj::ArrayPtr<const char> extractProtocolFromUrl(kj::StringPtr url);

kj::String base64Encode(kj::ArrayPtr<const byte> input, bool breakLines);
// Encode the input as base64. If `breakLines` is true, insert line breaks every 72 characters and
// at the end of the output. (Otherwise, return one long line.)

kj::Array<byte> base64Decode(kj::StringPtr input);
// Decode base64 input to bytes. Non-base64 characters in the input will be ignored.

}  // namespace sandstorm

#endif // SANDSTORM_UTIL_H_
