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
#include <kj/test.h>
#include <sys/wait.h>
#include <kj/async-io.h>

namespace sandstorm {
namespace {

KJ_TEST("HeaderWhitelist") {
  const char* WHITELIST[] = {
    "bar-baz",
    "corge",
    "foo-*",
    "grault",
    "qux-*",
  };

  HeaderWhitelist whitelist((kj::ArrayPtr<const char*>(WHITELIST)));

  KJ_ASSERT(whitelist.matches("bar-baz"));
  KJ_ASSERT(whitelist.matches("bar-BAZ"));
  KJ_ASSERT(!whitelist.matches("bar-qux"));
  KJ_ASSERT(whitelist.matches("foo-abcd"));
  KJ_ASSERT(whitelist.matches("grault"));
  KJ_ASSERT(whitelist.matches("Grault"));
  KJ_ASSERT(!whitelist.matches("grault-abcd"));
  KJ_ASSERT(whitelist.matches("QUX-abcd"));
  KJ_ASSERT(!whitelist.matches("quxqux"));
}

struct Pipe {
  kj::AutoCloseFd readEnd;
  kj::AutoCloseFd writeEnd;
};

Pipe makePipe() {
  int fds[2];
  KJ_SYSCALL(pipe2(fds, O_CLOEXEC));
  return { kj::AutoCloseFd(fds[0]), kj::AutoCloseFd(fds[1]) };
}

bool hasSubstring(kj::StringPtr haystack, kj::StringPtr needle) {
  if (needle.size() <= haystack.size()) {
    for (size_t i = 0; i <= haystack.size() - needle.size(); i++) {
      if (haystack.slice(i).startsWith(needle)) {
        return true;
      }
    }
  }
  return false;
}

KJ_TEST("Subprocess") {
  {
    Subprocess child({"true"});
    child.waitForSuccess();
  }

  {
    Subprocess child({"false"});
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Subprocess child({"false"});
    KJ_EXPECT_THROW_MESSAGE("child process failed", child.waitForSuccess());
  }

  {
    Subprocess child({"cat"});
    // Will be killed by destructor.
  }

  {
    Subprocess child({"cat"});
    child.signal(SIGKILL);
    int status = child.waitForExitOrSignal();
    KJ_EXPECT(WIFSIGNALED(status));
    KJ_EXPECT(WTERMSIG(status) == SIGKILL);
  }

  {
    Subprocess child({"cat"});
    child.signal(SIGKILL);
    KJ_EXPECT_THROW_MESSAGE("child process killed by signal", (void)child.waitForExit());
  }

  {
    Subprocess child([&]() {
      return 0;
    });
    child.waitForSuccess();
  }

  {
    Subprocess child([&]() {
      return 123;
    });
    KJ_EXPECT(child.waitForExit() == 123);
  }

  {
    Pipe pipe = makePipe();
    Subprocess child([&]() {
      KJ_SYSCALL(write(pipe.writeEnd, "foo", 3));
      pipe.writeEnd = nullptr;
      return 0;
    });
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo");
  }

  {
    Pipe pipe = makePipe();
    Subprocess::Options options({"echo", "foo"});
    options.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo\n");
    child.waitForSuccess();
  }

  {
    Pipe inPipe = makePipe();
    Pipe outPipe = makePipe();
    Subprocess::Options options({"cat"});
    options.stdin = inPipe.readEnd;
    options.stdout = outPipe.writeEnd;
    Subprocess child(kj::mv(options));
    inPipe.readEnd = nullptr;
    outPipe.writeEnd = nullptr;
    KJ_SYSCALL(write(inPipe.writeEnd, "foo", 3));
    inPipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(outPipe.readEnd) == "foo");
    child.waitForSuccess();
  }

  {
    Pipe pipe = makePipe();
    Subprocess::Options options({"no-such-file-eb8c433f35f3063e"});
    options.stderr = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(hasSubstring(readAll(pipe.readEnd), "execvp("));
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Pipe pipe = makePipe();
    Subprocess::Options options({"true"});
    options.stderr = pipe.writeEnd;
    options.searchPath = false;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(hasSubstring(readAll(pipe.readEnd), "execv("));
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Subprocess::Options options({"/bin/true"});
    options.searchPath = false;
    Subprocess child(kj::mv(options));
    child.waitForSuccess();
  }

  {
    Pipe pipe = makePipe();
    Subprocess::Options options({"sh", "-c", "echo $UTIL_TEST_ENV"});
    auto env = kj::heapArray<const kj::StringPtr>({"PATH=/bin:/usr/bin", "UTIL_TEST_ENV=foo"});
    options.environment = env.asPtr();
    options.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo\n");
    child.waitForSuccess();
  }

  {
    Pipe pipe3 = makePipe();
    Pipe pipe4 = makePipe();
    Subprocess::Options options({"sh", "-c", "echo foo >&3; echo bar >&4"});
    auto fds = kj::heapArray<int>({pipe3.writeEnd, pipe4.writeEnd});
    options.moreFds = fds;

    // We override the environment here in order to clear Ekam's LD_PRELOAD which otherwise expects
    // FD 3 and 4 to belong to it.
    auto env = kj::heapArray<const kj::StringPtr>({"PATH=/bin:/usr/bin"});
    options.environment = env.asPtr();

    Subprocess child(kj::mv(options));
    pipe3.writeEnd = nullptr;
    pipe4.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe3.readEnd) == "foo\n");
    KJ_EXPECT(readAll(pipe4.readEnd) == "bar\n");
    child.waitForSuccess();
  }
}

KJ_TEST("SubprocessSet") {
  auto io = kj::setupAsyncIo();

  SubprocessSet set(io.unixEventPort);

  Subprocess::Options catOptions("cat");
  Pipe catPipe = makePipe();
  catOptions.stdin = catPipe.readEnd;
  Subprocess childCat(kj::mv(catOptions));
  catPipe.readEnd = nullptr;

  Subprocess childTrue({"true"});

  bool catDone = false;

  auto promiseCat = set.waitForSuccess(childCat).then([&]() { catDone = true; });
  auto promiseTrue = set.waitForSuccess(childTrue);
  auto promiseFalse = set.waitForExit({"false"});

  promiseTrue.wait(io.waitScope);
  KJ_EXPECT(promiseFalse.wait(io.waitScope) != 0);
  KJ_EXPECT(!catDone);

  catPipe.writeEnd = nullptr;
  promiseCat.wait(io.waitScope);
}

KJ_TEST("raiiOpenAtIfExistsContained") {
  {
    char tempdir[] = "/tmp/sandstorm-test.XXXXXX";
    KJ_REQUIRE(mkdtemp(tempdir) != nullptr);
    KJ_DEFER(KJ_SYSCALL(rmdir(tempdir)));

    auto dir = raiiOpen(tempdir, O_DIRECTORY);

    raiiOpenAt(dir.get(), "file", O_CREAT | O_RDWR);
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "file", 0)));

    KJ_SYSCALL(symlinkat("file", dir.get(), "link-to-file"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "link-to-file", 0)));

    KJ_SYSCALL(symlinkat("..", dir.get(), "link-to-parent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "link-to-parent", 0)));

    KJ_SYSCALL(symlinkat("/", dir.get(), "link-to-root"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "link-to-root", 0)));

    KJ_SYSCALL(mkdirat(dir.get(), "subdir", 0700));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir", AT_REMOVEDIR)));

    KJ_SYSCALL(symlinkat("..", dir.get(), "subdir/link-to-parent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-parent", 0)));

    KJ_SYSCALL(symlinkat("../..", dir.get(), "subdir/link-to-grandparent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-grandparent", 0)));

    KJ_SYSCALL(symlinkat("/", dir.get(), "subdir/link-to-root"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-root", 0)));


    auto expectSucceed = [&](kj::StringPtr path) -> kj::AutoCloseFd {
      KJ_IF_MAYBE(fd, raiiOpenAtIfExistsContained(dir.get(), path, O_RDONLY)) {
        return kj::mv(*fd);
      } else {
        KJ_FAIL_ASSERT("Opening ", path, " should have succeeded.");
      }
    };

    auto expectFail = [&](kj::StringPtr path) {
      auto maybeExn = kj::runCatchingExceptions([&]() {
        raiiOpenAtIfExistsContained(dir.get(), path, O_RDONLY);
      });
      KJ_IF_MAYBE(exn, maybeExn) {
      } else {
        KJ_FAIL_ASSERT("Opening ", path, " should have failed.");
      }
    };

    auto expectRootTruncated = [&](kj::StringPtr path) {
      auto root = expectSucceed(path);
      int result = faccessat(root.get(), "tmp", F_OK, AT_SYMLINK_NOFOLLOW);
      KJ_ASSERT(result < 0, "shouldn't have gotten access to /");
    };

    expectSucceed("link-to-file");
    expectFail("link-to-parent");
    expectRootTruncated("link-to-root");
    expectSucceed("subdir/link-to-parent");
    expectFail("subdir/link-to-grandparent");
    expectRootTruncated("subdir/link-to-root");
  }
}

}  // namespace
}  // namespace sandstorm
