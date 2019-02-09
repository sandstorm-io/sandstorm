// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2018 Sandstorm Development Group, Inc. and contributors
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

#include "smtp-proxy.h"

namespace sandstorm {

namespace {

class AsyncLineReader: public kj::AsyncIoStream {
public:
  AsyncLineReader(kj::Own<kj::AsyncIoStream> inner): inner(kj::mv(inner)) {}

  kj::Promise<kj::String> readLine() {
    char* end = reinterpret_cast<char*>(memchr(lineBuffer, '\n', fill));
    if (end == nullptr) {
      return inner->tryRead(lineBuffer + fill, 1, sizeof(lineBuffer) - fill)
          .then([this](size_t amount) -> kj::Promise<kj::String> {
        if (amount == 0) {
          return KJ_EXCEPTION(DISCONNECTED, "SMTP connection disconnected mid-line");
        }
        fill += amount;
        return readLine();
      });
    }

    size_t len = end - lineBuffer + 1;
    auto result = kj::heapString(lineBuffer, len);
    KJ_ASSERT(fill >= len, fill, len, (void*)end);
    fill -= len;
    memmove(lineBuffer, lineBuffer + len, fill);
    return kj::mv(result);
  }

  kj::Promise<size_t> tryRead(void* buffer, size_t minBytes, size_t maxBytes) override {
    if (fill >= maxBytes) {
      memcpy(buffer, lineBuffer, maxBytes);
      fill -= maxBytes;
      memmove(lineBuffer, lineBuffer + maxBytes, fill);
      return maxBytes;
    } else if (fill >= minBytes) {
      memcpy(buffer, lineBuffer, fill);
      size_t result = fill;
      fill = 0;
      return result;
    } else if (fill > 0) {
      memcpy(buffer, lineBuffer, fill);
      size_t n = fill;
      fill = 0;
      return inner->tryRead(reinterpret_cast<char*>(buffer) + n,
                            minBytes - n, maxBytes - n)
          .then([n](size_t amount) { return n + amount; });
    } else {
      return inner->tryRead(buffer, minBytes, maxBytes);
    }
  }
  kj::Maybe<uint64_t> tryGetLength() override {
    return inner->tryGetLength().map([this](uint64_t size) { return size + fill; });
  }
  kj::Promise<uint64_t> pumpTo(kj::AsyncOutputStream& output,
                               uint64_t amount = kj::maxValue) override {
    if (fill >= amount) {
      return output.write(lineBuffer, amount)
         .then([this,amount]() {
        fill -= amount;
        memmove(lineBuffer, lineBuffer + amount, fill);
        return amount;
      });
    } else if (fill > 0) {
      return output.write(lineBuffer, fill)
         .then([this,&output,amount]() {
        uint n = fill;
        fill = 0;
        return inner->pumpTo(output, amount - n)
            .then([n](size_t actual) { return n + actual; });
      });
    } else {
      return inner->pumpTo(output, amount);
    }
  }

  kj::Promise<void> write(const void* buffer, size_t size) override {
    return inner->write(buffer, size);
  }
  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const byte>> pieces) override {
    return inner->write(pieces);
  }
  kj::Maybe<kj::Promise<uint64_t>> tryPumpFrom(
      kj::AsyncInputStream& input, uint64_t amount = kj::maxValue) override {
    return inner->tryPumpFrom(input, amount);
  }
  kj::Promise<void> whenWriteDisconnected() override {
    return inner->whenWriteDisconnected();
  }
  void shutdownWrite() override {
    return inner->shutdownWrite();
  }
  void abortRead() override {
    return inner->abortRead();
  }

private:
  kj::Own<kj::AsyncIoStream> inner;

  uint fill = 0;
  // Number of bytes in `buffer` that have been filled in.

  char lineBuffer[1000];
  // SMTP suggests that receivers should accept any line length, but also requires senders to limit
  // lines to 1000 characters (aka 998 characters plus CRLF).
};

bool startsWithCaseInsensitive(kj::StringPtr text, kj::StringPtr prefix) {
  return strncasecmp(text.begin(), prefix.begin(), prefix.size()) == 0;
}

class SmtpProxySession {
public:
  SmtpProxySession(kj::TlsContext& tls, kj::Own<kj::AsyncIoStream> client,
                   kj::Own<kj::AsyncIoStream> server)
      : tls(tls),
        client(kj::heap<AsyncLineReader>(kj::mv(client))),
        server(kj::heap<AsyncLineReader>(kj::mv(server))) {}

  kj::Promise<void> run() {
    // Wait for first line from server, forward to client. Then wait for client commands.
    return server->readLine()
        .then([this](kj::String line) {
      auto promise = client->write(line.begin(), line.size());
      return promise.attach(kj::mv(line))
          .then([this]() { return waitClient(); });
    });
  }

private:
  kj::TlsContext& tls;
  kj::Own<AsyncLineReader> client;
  kj::Own<AsyncLineReader> server;

  kj::Promise<void> waitClient() {
    return client->readLine()
        .then([this](kj::String line) {
      if (startsWithCaseInsensitive(line, "EHLO")) {
        auto promise = server->write(line.begin(), line.size());
        return promise.attach(kj::mv(line))
            .then([this]() { return waitServerEhlo(); });
      } else if (startsWithCaseInsensitive(line, "STARTTLS")) {
        // Yay security!
        constexpr kj::StringPtr REPLY = "220 Thank you for being secure\r\n"_kj;
        return client->write(REPLY.begin(), REPLY.size())
            .then([this]() { return tls.wrapServer(kj::mv(client)); })
            .then([this](kj::Own<kj::AsyncIoStream> tlsClient) {
          // TODO(someday): In theory we should actually start an all-new connection here.
          return pumpDuplex(kj::mv(tlsClient), kj::mv(server));
        });
      } else {
        // Command not recognized. Give up intercepting now, on assumption that a secure client
        // would never execute any command except EHLO and STARTTLS in plaintext.
        //
        // TODO(someday): Allow server to refuse plaintext connections?
        auto promise = server->write(line.begin(), line.size());
        return promise.attach(kj::mv(line)).then([this]() {
          return pumpDuplex(kj::mv(client), kj::mv(server));
        });
      }
    });
  }

  kj::Promise<void> waitServerEhlo() {
    return server->readLine()
        .then([this](kj::String line) {
      bool end = false;
      if (line.startsWith("250 ")) {
        // Last line of successful response. Add STARTTLS advertisement.
        line = kj::str("250-", line.slice(4), "250 STARTTLS\r\n");
        end = true;
      } else if (line.size() < 4 || line[3] == ' ') {
        // Last line of some non-successful response?
        end = true;
      }

      auto promise = client->write(line.begin(), line.size());
      return promise.attach(kj::mv(line))
          .then([this,end]() {
        if (end) {
          return waitClient();
        } else {
          return waitServerEhlo();
        }
      });
    });
  }
};

}  // namespace

kj::Promise<void> proxySmtp(
    kj::TlsContext& tls, kj::Own<kj::AsyncIoStream> client, kj::NetworkAddress& server) {
  return server.connect()
      .then([&tls,client = kj::mv(client)](kj::Own<kj::AsyncIoStream> server) mutable {
    auto session = kj::heap<SmtpProxySession>(tls, kj::mv(client), kj::mv(server));
    auto promise = session->run();
    return promise.attach(kj::mv(session));
  });
}

}  // namespace sandstorm
