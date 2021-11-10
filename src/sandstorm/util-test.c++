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
    Pipe pipe = Pipe::make();
    Subprocess child([&]() {
      KJ_SYSCALL(write(pipe.writeEnd, "foo", 3));
      pipe.writeEnd = nullptr;
      return 0;
    });
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo");
  }

  {
    Pipe pipe = Pipe::make();
    Subprocess::Options options({"echo", "foo"});
    options.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo\n");
    child.waitForSuccess();
  }

  {
    Pipe inPipe = Pipe::make();
    Pipe outPipe = Pipe::make();
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
    Pipe pipe = Pipe::make();
    Subprocess::Options options({"no-such-file-eb8c433f35f3063e"});
    options.stderr = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(hasSubstring(readAll(pipe.readEnd), "execvp("));
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Pipe pipe = Pipe::make();
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
    Pipe pipe = Pipe::make();
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
    Pipe pipe3 = Pipe::make();
    Pipe pipe4 = Pipe::make();
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
  Pipe catPipe = Pipe::make();
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

    auto writeFileAt = [&](int fd, kj::StringPtr path, kj::StringPtr data) {
      auto file = raiiOpenAt(fd, path, O_CREAT | O_RDWR);
      KJ_SYSCALL(write(file.get(), data.cStr(), data.size()));
    };

    writeFileAt(dir.get(), "file", "file");
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

    KJ_SYSCALL(symlinkat("../file", dir.get(), "subdir/link-to-parent-file"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-parent-file", 0)));

    writeFileAt(dir.get(), "subdir/file", "subdir/file");
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/file", 0)));

    KJ_SYSCALL(symlinkat("file", dir.get(), "subdir/link-to-subdir-file"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-subdir-file", 0)));

    KJ_SYSCALL(symlinkat("../..", dir.get(), "subdir/link-to-grandparent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-grandparent", 0)));

    KJ_SYSCALL(symlinkat("/", dir.get(), "subdir/link-to-root"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-root", 0)));

    KJ_SYSCALL(mkdirat(dir.get(), "subdir/a", 0700));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a", AT_REMOVEDIR)));

    KJ_SYSCALL(mkdirat(dir.get(), "subdir/a/b", 0700));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b", AT_REMOVEDIR)));

    writeFileAt(dir.get(), "subdir/a/b/c", "subdir/a/b/c");
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b/c", 0)));

    KJ_SYSCALL(symlinkat("c", dir.get(), "subdir/a/b/link-to-c"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b/link-to-c", 0)));

    KJ_SYSCALL(symlinkat("b", dir.get(), "subdir/a/link-to-b"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/link-to-b", 0)));

    KJ_SYSCALL(symlinkat("..", dir.get(), "subdir/a/b/link-to-a"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b/link-to-a", 0)));

    auto expectSucceed = [&](kj::StringPtr path) -> kj::AutoCloseFd {
      KJ_IF_MAYBE(fd, raiiOpenAtIfExistsContained(dir.get(), kj::Path::parse(path), O_RDONLY)) {
        return kj::mv(*fd);
      } else {
        KJ_FAIL_ASSERT("Opening ", path, " should have succeeded.");
      }
    };

    auto expectFail = [&](kj::StringPtr path) {
      auto maybeExn = kj::runCatchingExceptions([&]() {
        raiiOpenAtIfExistsContained(dir.get(), kj::Path::parse(path), O_RDONLY);
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

    auto readFile = [&](kj::StringPtr path) -> kj::String {
      return kj::FdInputStream(expectSucceed(path)).readAllText();
    };

    auto expectContents = [&](kj::StringPtr path, kj::StringPtr expected) {
      auto actual = readFile(path);
      if(actual != expected) {
        KJ_FAIL_ASSERT("unexpected contents", expected, actual);
      }
    };

    expectContents("link-to-file", "file");
    expectFail("link-to-parent");
    expectRootTruncated("link-to-root");
    expectSucceed("subdir/link-to-parent");
    expectContents("subdir/link-to-parent-file", "file");
    expectContents("subdir/link-to-subdir-file", "subdir/file");
    expectFail("subdir/link-to-grandparent");
    expectRootTruncated("subdir/link-to-root");
    expectContents("subdir/a/b/link-to-c", "subdir/a/b/c");
    expectContents("subdir/a/link-to-b/c", "subdir/a/b/c");
    expectContents("subdir/a/link-to-b/link-to-c", "subdir/a/b/c");
    expectContents("subdir/a/b/link-to-a/b/c", "subdir/a/b/c");
  }
}

}  // namespace
}  // namespace sandstorm
