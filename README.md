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

See:  [sandstorm.io](https://sandstorm.io)

## Caveats

### *WARNING! WARNING!*

Sandstorm is in the very early stages of development.  We want developers to start playing with it, but keep some things in mind:

* At present, Sandstorm's sandboxing is incomplete.  Malicious code probably can escape.  Malicious code _definitely can_ DoS your server by consuming all available resources.
* The sharing model is very primitive right now.  Simply copy/paste an app instance link to share it with others.
* The UI stinks.  We're working on it.
* Apps can't do a whole lot yet, since we don't have many APIs to interact with the outside world.  See our [future plans](#the-future) and [let us know](https://groups.google.com/group/sandstorm-dev) what we should build next!
* The API (what there is of it) is not final.  It could change in a way that breaks existing apps.

## Installing the Easy Way

To install on your own Linux machine, just do:

    curl https://install.sandstorm.io | bash

Or, if you don't like piping directly to shell, download first:

    curl https://install.sandstorm.io > install.sh
    bash install.sh

This will install a self-contained and (optionally) auto-updating Sandstorm bundle. It won't touch anything on your system other than your chosen installation directory and (optional) init script.

Please note that Sandstorm requires root access to set up the sandbox. If this bothers you, consider
installing it in its own VM.

## Installing from Source

### Prerequisites

Please install the following:

* Linux, with reasonably new kernel version.  (Note:  Sandstorm currently does not work under LXC / Docker.  We'd like to fix this, but it's tricky.)
* `libcap` with headers (e.g. `libcap-dev` on Debian/Ubuntu)
* `pkg-config` (make sure this is installed _before_ building libsodium)
* `XZ` for installing packages (`xz-utils` on Debian/Ubuntu)
* [Clang compiler](http://clang.llvm.org/) version 3.4 or better.  WARNING:  Ubuntu Saucy's `clang-3.4` package is NOT Clang 3.4!  It's actually some random cut from trunk between 3.3 and 3.4, and it's not new enough.  Try <a href="http://llvm.org/apt/">the official packages from LLVM</a> instead.
* [Cap'n Proto](http://capnproto.org) from git (do not use a release version -- Sandstorm and Cap'n Proto are being developed together, so Sandstorm often uses brand-new Cap'n Proto features)
* [libsodium](https://github.com/jedisct1/libsodium) latest release
* [Meteor](http://meteor.com)
* [Meteorite](https://github.com/oortcloud/meteorite)
* [npm](http://npmjs.org) module `es6-promise`

### Building / installing the binaries

    make
    sudo make install SANDSTORM_USER=$USER:$USER

You should replace `$USER:$USER` with the user:group pair under which the sandstorm shell will run.  The above is appropriate if you want to run it as yourself.

Note that the binary `sandstorm-supervisor` is installed setuid-root.  This is necessary because the Linux kernel sandboxing features are only available to root (except on very new kernels with UID namespaces which Sandstorm doesn't yet use).  This program is believed to be safe, but in this early stage it may be advisable not to install sandstorm on a system where malicious users may have shell access.

### Running the shell

    cd shell
    mrt install
    meteor

Now connect to: http://localhost:3000

Follow the on-screen instructions to configure the login system and sign yourself in.  The first user to sign in automatically becomes administrator, with the ability to invite other users.

Keep in mind that currently there are no resource quotas, so anyone you give access will be able to fill up your hard drive and use all your CPU and RAM.  Therefore, it's a good idea only to invite friendly people for now.

Tips:
* Sandstorm serves the front-end on port 3000, but serves each app on a different port, starting from 7000 and counting up (the more files you have open at once, the more ports are used).  If there is a firewall or NAT between you and the server, you'll need to open these ports.
* For a more production-y installation, run "meteor bundle" to build a deployment tarball, unpack it, and follow the instructions in the readme.  Keep in mind that the `spk` and `sandstorm-supervisor` binaries must be available in the `PATH` wherever the shell runs.
* If you want to run on port 80, we recommend setting up an [nginx](http://nginx.org/) reverse proxy rather than trying to get Node to open port 80 directly.  Make sure to configure [WebSocket forwarding](http://nginx.org/en/docs/http/websocket.html), which requires nginx 1.3.13 or better.
* If you want SSL, then you will definitely need an nginx proxy (or something equivalent).  You will further need to use a wildcard certificate, and wildcard DNS.  In SSL mode, Sandstorm switches from using ports for each app to using different host names, formed by adding `-$PORT` to the first component of the shell's host name.  For example, for `alpha.sandstorm.io`, apps are hosted from `alpha-7000.sandstorm.io`, `alpha-7001.sandstorm.io`, etc.  You will need to configure nginx to forward each of these host names to the corresponding local port number; this can be done easily with a regex rule.
* If you are not pointing your browser strictly at `http://localhost:3000`, you need to set the environment variable `ROOT_URL` to the URL seen by the browser in order for the OAuth handshakes to work, e.g. `ROOT_URL=https://alpha.sandstorm.io meteor`.

For reference, [nginx-example.conf](nginx-example.conf) contains the http server part of nginx config used by Sandstorm Alpha.

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

### *** TEMPORARILY MISSING ***

May 8, 2014: The way to port apps is in flux. Please check back in a day or
two, or [check the mailing list](https://groups.google.com/group/sandstorm-dev).
It's about to become much, much easier! :)

## The Future

As of March 2014, sandboxed apps can receive and respond to HTTP and WebSocket requests from users of the Sandstorm shell interface.  That's it.  This is enough for document-editor-type apps, but not anything that needs to interact with the world.

However, we want to allow apps to do many more things in the future:

* Export [Cap'n Proto](http://capnproto.org) RPC APIs which can then be used from other apps, with permissions mediated through a [powerbox](http://plash.beasts.org/powerbox.html)-style user interface.
* Export external RESTful APIs (to non-Sandstorm clients) with OAuth handled by the platform.
* Publish static content under a domain name -- accessible to the whole world without going through the sandstorm shell -- as a way to maintain a web site / blog using a Sandstorm app.
* Send and receive e-mail, XMPP, etc.
* Make outbound HTTP requests (to servers approved by the user), with OAuth credentials managed by the platform.
* Specify multiple "permission levels" which can be used with sharing, so that a user can e.g. share read-only access to a document.
* Publish static assets to be served directly by the Sandstorm infrastructure so that these requests need not pass through the app's sandbox.
* Integrate securely with desktop and mobile client apps -- imagine installing a Sandstorm app and having the mobile client installed automatically, with permission only to talk to its server.

We hope that this will enable apps like:

* E-mail / chat / communications.
* Federated social networks.
* Documents / spreedsheets / etc.
* Media storage and playback.
* Most importantly:  Things that we don't expect!

Have a great idea for an app?  [Share it with us](https://groups.google.com/group/sandstorm-dev), and we'll help you figure out how to make it fit in Sandstorm.

## Contribute

Want to help?  Get on the [discussion group](https://groups.google.com/group/sandstorm-dev) and let us know!
