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

#include "util.h"
#include <errno.h>
#include <kj/vector.h>
#include <ctype.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/types.h>
#include <dirent.h>

namespace sandstorm {

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode) {
  int fd;
  KJ_SYSCALL(fd = open(name.cStr(), flags, mode), name);
  return kj::AutoCloseFd(fd);
}

kj::Maybe<kj::AutoCloseFd> raiiOpenIfExists(kj::StringPtr name, int flags, mode_t mode) {
  int fd = open(name.cStr(), flags, mode);
  if (fd == -1) {
    if (errno == ENOENT) {
      return nullptr;
    } else {
      KJ_FAIL_SYSCALL("open", errno, name);
    }
  } else {
    return kj::AutoCloseFd(fd);
  }
}

kj::Maybe<kj::String> readLine(kj::BufferedInputStream& input) {
  kj::Vector<char> result(80);

  for (;;) {
    auto buffer = input.tryGetReadBuffer();
    if (buffer.size() == 0) {
      KJ_REQUIRE(result.size() == 0, "Got partial line.");
      return nullptr;
    }
    for (size_t i: kj::indices(buffer)) {
      if (buffer[i] == '\n') {
        input.skip(i+1);
        result.add('\0');
        return kj::String(result.releaseAsArray());
      } else {
        result.add(buffer[i]);
      }
    }
    input.skip(buffer.size());
  }
}

kj::ArrayPtr<const char> trimArray(kj::ArrayPtr<const char> slice) {
  while (slice.size() > 0 && isspace(slice[0])) {
    slice = slice.slice(1, slice.size());
  }
  while (slice.size() > 0 && isspace(slice[slice.size() - 1])) {
    slice = slice.slice(0, slice.size() - 1);
  }

  return slice;
}

kj::String trim(kj::ArrayPtr<const char> slice) {
  return kj::heapString(trimArray(slice));
}

void toLower(kj::ArrayPtr<char> text) {
  for (char& c: text) {
    if ('A' <= c && c <= 'Z') {
      c = c - 'A' + 'a';
    }
  }
}

kj::Maybe<uint> parseUInt(kj::StringPtr s, int base) {
  char* end;
  uint result = strtoul(s.cStr(), &end, base);
  if (s.size() == 0 || *end != '\0') {
    return nullptr;
  }
  return result;
}

kj::AutoCloseFd openTemporary(kj::StringPtr near) {
  // TODO(someday):  Use O_TMPFILE?  New in Linux 3.11.

  int fd;
  auto name = kj::str(near, ".XXXXXX");
  KJ_SYSCALL(fd = mkostemp(name.begin(), O_CLOEXEC));
  kj::AutoCloseFd result(fd);
  KJ_SYSCALL(unlink(name.cStr()));
  return result;
}

bool isDirectory(kj::StringPtr path) {
  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats));
  return S_ISDIR(stats.st_mode);
}

kj::Array<kj::String> listDirectory(kj::StringPtr dirname) {
  DIR* dir = opendir(dirname.cStr());
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("opendir", errno, dirname);
  }
  KJ_DEFER(closedir(dir));

  kj::Vector<kj::String> entries;

  for (;;) {
    errno = 0;
    struct dirent* entry = readdir(dir);
    if (entry == nullptr) {
      int error = errno;
      if (error == 0) {
        break;
      } else {
        KJ_FAIL_SYSCALL("readdir", error, dirname);
      }
    }

    kj::StringPtr name = entry->d_name;
    if (name != "." && name != "..") {
      entries.add(kj::heapString(entry->d_name));
    }
  }

  return entries.releaseAsArray();
}

void recursivelyDelete(kj::StringPtr path) {
  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats), path) { return; }
  if (S_ISDIR(stats.st_mode)) {
    for (auto& file: listDirectory(path)) {
      recursivelyDelete(kj::str(path, "/", file));
    }
    KJ_SYSCALL(rmdir(path.cStr()), path) { break; }
  } else {
    KJ_SYSCALL(unlink(path.cStr()), path) { break; }
  }
}

kj::String readAll(int fd) {
  kj::FdInputStream input(fd);
  kj::Vector<char> content;
  for (;;) {
    char buffer[4096];
    size_t n = input.tryRead(buffer, sizeof(buffer), sizeof(buffer));
    content.addAll(buffer, buffer + n);
    if (n < sizeof(buffer)) {
      // Done!
      break;
    }
  }
  content.add('\0');
  return kj::String(content.releaseAsArray());
}

kj::String readAll(kj::StringPtr name) {
  return readAll(raiiOpen(name, O_RDONLY));
}

kj::Array<kj::String> splitLines(kj::String input) {
  size_t lineStart = 0;
  kj::Vector<kj::String> results;
  for (size_t i = 0; i < input.size(); i++) {
    if (input[i] == '\n' || input[i] == '#') {
      bool hasComment = input[i] == '#';
      input[i] = '\0';
      auto line = trim(input.slice(lineStart, i));
      if (line.size() > 0) {
        results.add(kj::mv(line));
      }
      if (hasComment) {
        // Ignore through newline.
        ++i;
        while (i < input.size() && input[i] != '\n') ++i;
      }
      lineStart = i + 1;
    }
  }

  if (lineStart < input.size()) {
    auto lastLine = trim(input.slice(lineStart));
    if (lastLine.size() > 0) {
      results.add(kj::mv(lastLine));
    }
  }

  return results.releaseAsArray();
}

kj::Vector<kj::ArrayPtr<const char>> split(kj::ArrayPtr<const char> input, char delim) {
  kj::Vector<kj::ArrayPtr<const char>> result;

  size_t start = 0;
  for (size_t i: kj::indices(input)) {
    if (input[i] == delim) {
      result.add(input.slice(start, i));
      start = i + 1;
    }
  }
  result.add(input.slice(start, input.size()));
  return result;
}

kj::Maybe<kj::ArrayPtr<const char>> splitFirst(kj::ArrayPtr<const char>& input, char delim) {
  for (size_t i: kj::indices(input)) {
    if (input[i] == delim) {
      auto result = input.slice(0, i);
      input = input.slice(i + 1, input.size());
      return result;
    }
  }
  return nullptr;
}

kj::ArrayPtr<const char> extractHostFromUrl(kj::StringPtr url) {
  while (url.size() > 0 && 'a' <= url[0] && url[0] <= 'z') {
    url = url.slice(1);
  }
  KJ_REQUIRE(url.startsWith("://"), "Base URL does not have a protocol scheme?");
  url = url.slice(3);
  KJ_IF_MAYBE(slashPos, url.findFirst('/')) {
    return url.slice(0, *slashPos);
  } else {
    return url;
  }
}

kj::ArrayPtr<const char> extractProtocolFromUrl(kj::StringPtr url) {
  KJ_IF_MAYBE(colonPos, url.findFirst(':')) {
    return url.slice(0, *colonPos);
  } else {
    KJ_FAIL_REQUIRE("Base URL does not have a protocol scheme.", url);
  }
}

// =======================================================================================
// This code is derived from libb64 which has been placed in the public domain.
// For details, see http://sourceforge.net/projects/libb64

typedef enum {
  step_A, step_B, step_C
} base64_encodestep;

typedef struct {
  base64_encodestep step;
  char result;
  int stepcount;
} base64_encodestate;

const int CHARS_PER_LINE = 72;

void base64_init_encodestate(base64_encodestate* state_in) {
  state_in->step = step_A;
  state_in->result = 0;
  state_in->stepcount = 0;
}

char base64_encode_value(char value_in) {
  static const char* encoding = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value_in > 63) return '=';
  return encoding[(int)value_in];
}

int base64_encode_block(const char* plaintext_in, int length_in, char* code_out, base64_encodestate* state_in) {
  const char* plainchar = plaintext_in;
  const char* const plaintextend = plaintext_in + length_in;
  char* codechar = code_out;
  char result;
  char fragment;

  result = state_in->result;

  switch (state_in->step) {
    while (1) {
  case step_A:
      if (plainchar == plaintextend) {
        state_in->result = result;
        state_in->step = step_A;
        return codechar - code_out;
      }
      fragment = *plainchar++;
      result = (fragment & 0x0fc) >> 2;
      *codechar++ = base64_encode_value(result);
      result = (fragment & 0x003) << 4;
  case step_B:
      if (plainchar == plaintextend) {
        state_in->result = result;
        state_in->step = step_B;
        return codechar - code_out;
      }
      fragment = *plainchar++;
      result |= (fragment & 0x0f0) >> 4;
      *codechar++ = base64_encode_value(result);
      result = (fragment & 0x00f) << 2;
  case step_C:
      if (plainchar == plaintextend) {
        state_in->result = result;
        state_in->step = step_C;
        return codechar - code_out;
      }
      fragment = *plainchar++;
      result |= (fragment & 0x0c0) >> 6;
      *codechar++ = base64_encode_value(result);
      result  = (fragment & 0x03f) >> 0;
      *codechar++ = base64_encode_value(result);

      ++(state_in->stepcount);
      if (state_in->stepcount == CHARS_PER_LINE/4) {
        *codechar++ = '\n';
        state_in->stepcount = 0;
      }
    }
  }
  /* control should not reach here */
  return codechar - code_out;
}

int base64_encode_blockend(char* code_out, base64_encodestate* state_in) {
  char* codechar = code_out;

  switch (state_in->step) {
  case step_B:
    *codechar++ = base64_encode_value(state_in->result);
    *codechar++ = '=';
    *codechar++ = '=';
    break;
  case step_C:
    *codechar++ = base64_encode_value(state_in->result);
    *codechar++ = '=';
    break;
  case step_A:
    break;
  }
  *codechar++ = '\n';

  return codechar - code_out;
}

kj::String base64Encode(const kj::ArrayPtr<const byte> input) {
  /* set up a destination buffer large enough to hold the encoded data */
  // equivalent to ceil(input.size() / 3) * 4
  auto numChars = (input.size() + 2) / 3 * 4;
  auto output = kj::heapString(numChars + numChars / CHARS_PER_LINE + 1);
  /* keep track of our encoded position */
  char* c = output.begin();
  /* store the number of bytes encoded by a single call */
  int cnt = 0;
  size_t total = 0;
  /* we need an encoder state */
  base64_encodestate s;

  /*---------- START ENCODING ----------*/
  /* initialise the encoder state */
  base64_init_encodestate(&s);
  /* gather data from the input and send it to the output */
  cnt = base64_encode_block((const char *)input.begin(), input.size(), c, &s);
  c += cnt;
  total += cnt;

  /* since we have encoded the entire input string, we know that
     there is no more input data; finalise the encoding */
  cnt = base64_encode_blockend(c, &s);
  c += cnt;
  total += cnt;
  /*---------- STOP ENCODING  ----------*/

  // For the edge case, where the last line is 72+ characters, we will
  // print 1 less newline than usual
  while (total < output.size()) {
    *c++ = '\n';  // Add newlines to the end, since they will be ignored safely
    ++total;
  }

  return output;
}

}  // namespace sandstorm
