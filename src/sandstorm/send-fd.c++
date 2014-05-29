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

// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.

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
