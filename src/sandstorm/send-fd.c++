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

#include "send-fd.h"
#include <kj/debug.h>
#include <sys/socket.h>
#include <sys/un.h>

namespace sandstorm {

void sendFd(int sendOn, int fdToSend) {
  // Sends the fd over the given socket. A NUL byte is also sent, because at least one byte
  // must be written along with the FD.

  struct msghdr msg;
  struct iovec iov;
  union {
    struct cmsghdr cmsg;
    char cmsgSpace[CMSG_LEN(sizeof(int))];
  };
  memset(&msg, 0, sizeof(msg));
  memset(&iov, 0, sizeof(iov));
  memset(cmsgSpace, 0, sizeof(cmsgSpace));

  char c = 0;
  iov.iov_base = &c;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;

  msg.msg_control = &cmsg;
  msg.msg_controllen = sizeof(cmsgSpace);

  cmsg.cmsg_len = sizeof(cmsgSpace);
  cmsg.cmsg_level = SOL_SOCKET;
  cmsg.cmsg_type = SCM_RIGHTS;
  *reinterpret_cast<int*>(CMSG_DATA(&cmsg)) = fdToSend;

  KJ_SYSCALL(sendmsg(sendOn, &msg, 0));
}

kj::AutoCloseFd receiveFd(int sockFd) {
  return receiveFd(sockFd, [](kj::ArrayPtr<const kj::byte>) {
    KJ_FAIL_REQUIRE("Got unexpected data on unix socket while waiting for a file descriptor.");
  });
}

kj::AutoCloseFd receiveFd(int sockFd,
    kj::Function<void(kj::ArrayPtr<const kj::byte>)> dataCallback) {
  // Receive the fuse FD from the socket.  recvmsg() is complicated...  :/
  struct msghdr msg;
  memset(&msg, 0, sizeof(msg));

  // Make sure we have space to receive a byte so that recvmsg() doesn't simply return
  // immediately.
  struct iovec iov;
  memset(&iov, 0, sizeof(iov));
  kj::byte buffer[1024];
  iov.iov_base = &buffer;
  iov.iov_len = sizeof(buffer);
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;

  // Allocate space to receive a cmsg.
  union {
    struct cmsghdr cmsg;
    char cmsgSpace[CMSG_SPACE(sizeof(int))];
  };
  msg.msg_control = &cmsg;

  // Wait for the message.
  for (;;) {
    msg.msg_controllen = sizeof(cmsgSpace);

    ssize_t n;
    KJ_SYSCALL(n = recvmsg(sockFd, &msg, MSG_CMSG_CLOEXEC));
    KJ_ASSERT(n > 0, "premature EOF while waiting for FD");

    for (size_t i: kj::range<size_t>(0, n)) {
      if (buffer[i] == 0) {
        // Yay, here's our zero byte.
        if (i > 0) {
          dataCallback(kj::arrayPtr(buffer, i));
        }
        if (n > i + 1) {
          dataCallback(kj::arrayPtr(buffer + i + 1, n - i - 1));
        }

        KJ_ASSERT(msg.msg_controllen >= sizeof(cmsg), "expected fd on socket");

        // We expect an SCM_RIGHTS message with a single FD.
        KJ_ASSERT(cmsg.cmsg_level == SOL_SOCKET);
        KJ_ASSERT(cmsg.cmsg_type == SCM_RIGHTS);
        KJ_ASSERT(cmsg.cmsg_len == CMSG_LEN(sizeof(int)));

        return kj::AutoCloseFd(*reinterpret_cast<int*>(CMSG_DATA(&cmsg)));
      }
    }

    // No zero bytes; all data.
    dataCallback(kj::arrayPtr(buffer, n));

    KJ_ASSERT(msg.msg_controllen == 0, "expected zero byte with fd");
  }
}

}  // namespace sandstorm
