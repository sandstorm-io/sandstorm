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

#ifndef SANDSTORM_SEND_FD_H_
#define SANDSTORM_SEND_FD_H_

#include <kj/io.h>
#include <kj/function.h>

namespace sandstorm {

void sendFd(int sendOn, int fdToSend);
// Sends the fd over the given socket. A NUL byte is also sent, because at least one byte
// must be written along with the FD.
//
// TODO(cleanup): This function belongs in KJ.

kj::AutoCloseFd receiveFd(int sockFd);
kj::AutoCloseFd receiveFd(int sockFd,
    kj::Function<void(kj::ArrayPtr<const kj::byte>)> dataCallback);
// Helper function to receive a single file descriptor over a Unix socket (via SCM_RIGHTS control
// message). Since at least one regular data byte must be sent along with the SCM_RIGHTS message,
// this function expects a zero byte. Any non-zero bytes received (possibly either before or after
// the zero) are passed to `dataCallback` (which may be called multiple times). The function does
// not return until an FD has been received or EOF is reached or an error occurs (the latter two
// cases throw exceptions).
//
// TODO(cleanup): This function belongs in KJ.

}  // namespace sandstorm

#endif // SANDSTORM_SEND_FD_H_
