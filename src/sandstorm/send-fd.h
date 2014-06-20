// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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
