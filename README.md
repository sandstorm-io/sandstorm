# Sandstorm

* [Introduction](#introduction)
* [Caveats](#caveats)
* [Easy Install](#installing-the-easy-way)
* [Hard Install](#installing-from-source)
* [How it Works](#how-it-works)
* [How to Port Apps](#how-to-port-apps)
* [The Future](#the-future)
* [Contribute](#contribute)

## Introduction

See [sandstorm.io](https://sandstorm.io)

[Try the demo](https://demo.sandstorm.io)

[Fund us on Indiegogo](http://igg.me/at/sandstorm)

## Caveats

### *WARNING! WARNING!*

Sandstorm is in the very early stages of development. We want developers to start playing with it, but please don't rely on it for mission-critical data or security yet.

## Installing the Easy Way

To install on your own Linux machine, just do:

    curl https://install.sandstorm.io | bash

Or, if you don't like piping directly to shell, download first:

    curl https://install.sandstorm.io > install.sh
    bash install.sh

This will install a self-contained and (optionally) auto-updating Sandstorm bundle. It won't touch
anything on your system other than your chosen installation directory, optionally installing an
init script, and placing two symlinks (`spk` and `sandstorm`) under `/usr/local/bin`.

Note: If installing Sandstorm under LXC / Docker, you will need to choose the option to
install as a non-root user. Unfortunately, this means the development tools will not
work. This is due to the interaction between Sandstorm and Docker's use of Linux
containerization features and missing features in the Linux kernel which we
hope will be fixed eventually. For non-development purposes, Sandstorm should run just fine
under Docker.

### Tips

* If you want to run on port 80, we recommend setting up an [nginx](http://nginx.org/) reverse
  proxy rather than trying to get Node to open port 80 directly.  Make sure to configure
  [WebSocket forwarding](http://nginx.org/en/docs/http/websocket.html), which requires nginx
  1.3.13 or better.
* If you want SSL, then you will definitely need an nginx proxy (or something equivalent). You will
  further need to use a wildcard certificate.

For reference, [nginx-example.conf](nginx-example.conf) contains the http server part of nginx
config used by Sandstorm Alpha.

## Installing from Source

### Prerequisites

Please install the following:

* Linux, with reasonably new kernel version.
* Basic build tools: standard C and C++ libraries and headers, GNU Make (`build-essential` on Debian/Ubuntu)
* `libcap` with headers (e.g. `libcap-dev` on Debian/Ubuntu)
* `XZ` for installing packages (`xz-utils` on Debian/Ubuntu)
* `zip` and `unzip` commands
* `strace`
* [Clang compiler](http://clang.llvm.org/) version 3.4 or better. WARNING: Ubuntu Saucy's
  `clang-3.4` package is NOT Clang 3.4! It's actually some random cut from trunk between 3.3 and
  3.4, and it's not new enough.  Try <a href="http://llvm.org/apt/">the official packages from
  LLVM</a> instead.
* [Meteor](http://meteor.com)
* ImageMagick

### Building / installing the binaries

Build the Sandstorm bundle:

    make

(Note: You should *not* use `-j`, as we only use make as a meta-build system. The major components will utilize all CPU cores.)

Install it:

    make install

This installs your locally-built bundle just as would get if you had installed using
`https://install.sandstorm.io`. You will be asked various configuration questions. If you intend
to hack on Sandstorm itself, you should choose to run the server to run under your local user
account (the default is to create a separate user called `sandstorm`).

If Sandstorm is already installed, you can update to your newly-built version like so:

    make update

Note that this only works if you installed Sandstorm to run at startup. Otherwise, you will
have to manually do:

    /path/to/sandstorm update sandstorm-0.tar.xz

### Hacking on the shell

You can run the shell (front-end) in dev mode so that you can modify it without rebuilding the
whole bundle for every change. Just do:

    cd shell
    sudo service sandstorm stop-fe
    ./run-dev.sh

Now connect to your local server like you normally would.

Later, when you are done hacking, you may want to restart the installed front-end:

    sudo service sandstorm start-fe

### Hacking on the C++

If you're going to edit C++, you will want to install [Ekam](https://github.com/sandstorm-io/ekam), the build system used by Sandstorm. Be sure to read Ekam's wiki to understand how it works.

Once `ekam` is in your path, you can use `make continuous` in order to start an Ekam continuous build of Sandstorm. While this build is running, you can also run other `make` commands in a separate window. This will automatically synchronize with your continuous build rather than starting a second build.

To do a debug build, run make like:

    make continuous CXXFLAGS="-g"

If you suspect you'll be hacking on Sandstorm's dependencies as well, you may want to follow the dependency symlink trick described in the Ekam readme.

## How It Works

* Sandstorm's server-side sandboxing is based on the same underlying Linux kernel features as LXC and Docker.  We use the system calls directly for finer-grained control.
* (Planned) The kernel attack surface is reduced using seccomp-bpf to block and/or virtualize system calls.
* procfs, sysfs, etc. are not mounted in the sandbox, and only a minimal set of devices are available.
* (Planned) On the client side, apps run in a sandboxed iframe employing the `Content-Security-Policy` header to prevent them from sending any kind of network communication to any server other than their own.
* All communication between the sandboxed server and the outside world takes place through a single [Cap'n Proto](http://capnproto.org) RPC socket which the app's root process receives as file descriptor #3.  We've provided a program, `legacy-bridge`, which can receive HTTP-over-RPC requests on this socket and proxy them to a regular HTTP server running in the sandbox.
* Every object (e.g., each document) that you create with an application runs in a separate isolated sandbox.  We sandbox per-object rather than per-app so that it is easy and safe to share one object without also sharing everything created using the same app.
* An application package (`.spk` file) is essentially an archive containing an entire chroot environment in which the application runs.
* The application runs with the contents of its package mounted read-only, so that multiple instances of the same app can share disk space for the package.
* The application may store persistent state in the `/var` directory.
* App servers are aggressively killed off as soon as the user closes the browser tab, then restarted when the user returns later.
* Packages are cryptographically signed.  Packages signed with the same key represent versions of the same app, and are thus allowed to replace older versions -- although the user must still confirm these upgrades.

## How to Port Apps

See [the porting guide](https://github.com/sandstorm-io/sandstorm/wiki/Porting-Guide).

## Contribute

Want to help?  Get on the [discussion group](https://groups.google.com/group/sandstorm-dev) and let us know!
