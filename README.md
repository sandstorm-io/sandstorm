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

Sandstorm is in the very early stages of development.  We want developers to start playing with it,
but keep some things in mind:

* At present, Sandstorm's sandboxing is incomplete.  Malicious code probably can escape.  Malicious
  code _definitely can_ DoS your server by consuming all available resources.
* The sharing model is very primitive right now.  Simply copy/paste an app instance link to share
  it with others.
* There are no resource quotas yet. It's probably a good idea not to invite anyone who might abuse
  your server.
* The UI needs work.
* Apps can't do a whole lot yet, since we don't have many APIs to interact with the outside world.
  See our [future plans](#the-future) and
  [let us know](https://groups.google.com/group/sandstorm-dev) what we should build next!
* The API (what there is of it) is not final.  It could change in a way that breaks existing apps.

## Installing the Easy Way

To install on your own Linux machine, just do:

    curl https://install.sandstorm.io | bash

Or, if you don't like piping directly to shell, download first:

    curl https://install.sandstorm.io > install.sh
    bash install.sh

This will install a self-contained and (optionally) auto-updating Sandstorm bundle. It won't touch
anything on your system other than your chosen installation directory and (optional) init script.

Please note that Sandstorm requires root access to set up the sandbox. If this bothers you,
consider installing it in its own VM. Note: Sandstorm currently does not work under LXC /
Docker, because it uses the same kernel features, and making them nest requires kernel features
that only recently became available. We intend to fix this eventually.

### Tips

* Sandstorm serves the front-end on the port you choose, but serves each app on a different port,
  starting from 7000 and counting up (the more files you have open at once, the more ports are
  used).  If there is a firewall or NAT between you and the server, you'll need to open these ports.
* If you want to run on port 80, we recommend setting up an [nginx](http://nginx.org/) reverse
  proxy rather than trying to get Node to open port 80 directly.  Make sure to configure
  [WebSocket forwarding](http://nginx.org/en/docs/http/websocket.html), which requires nginx
  1.3.13 or better.
* If you want SSL, then you will definitely need an nginx proxy (or something equivalent). You will
  further need to use a wildcard certificate, and wildcard DNS. In SSL mode, Sandstorm switches
  from using ports for each app to using different host names, formed by adding `-$PORT` to the
  first component of the shell's host name. For example, for `alpha.sandstorm.io`, apps are hosted
  from `alpha-7000.sandstorm.io`, `alpha-7001.sandstorm.io`, etc. You will need to configure nginx
  to forward each of these host names to the corresponding local port number; this can be done
  easily with a regex rule.

For reference, [nginx-example.conf](nginx-example.conf) contains the http server part of nginx
config used by Sandstorm Alpha.

## Installing from Source

### Prerequisites

Please install the following:

* Linux, with reasonably new kernel version.
* `libcap` with headers (e.g. `libcap-dev` on Debian/Ubuntu)
* `libseccomp` with headers (e.g. `libseccomp-dev` on Debian/Ubuntu)
* `pkg-config` (make sure this is installed _before_ building libsodium)
* `XZ` for installing packages (`xz-utils` on Debian/Ubuntu)
* [Clang compiler](http://clang.llvm.org/) version 3.4 or better. WARNING: Ubuntu Saucy's
  `clang-3.4` package is NOT Clang 3.4! It's actually some random cut from trunk between 3.3 and
  3.4, and it's not new enough.  Try <a href="http://llvm.org/apt/">the official packages from
  LLVM</a> instead.
* [Cap'n Proto](http://capnproto.org) from git (do not use a release version -- Sandstorm and Cap'n
  Proto are being developed together, so Sandstorm often uses brand-new Cap'n Proto features)
* [libsodium](https://github.com/jedisct1/libsodium) latest release
* [Meteor](http://meteor.com)
* [Meteorite](https://github.com/oortcloud/meteorite)
* [npm](http://npmjs.org) module `jsontool`
* ImageMagick

### Building / installing the binaries

Build the Sandstorm bundle:

    make -j

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

    /path/to/sandstorm update $PWD/sandstorm-0.tar.xz

### Hacking on the shell

You can run the shell (front-end) in dev mode so that you can modify it without rebuilding the
whole bundle for every change. Just do:

    cd shell
    sudo service sandstorm stop-fe
    ./run-dev.sh

Now connect to your local server like you normally would.

Later, when you are done hacking, you may want to restart the installed front-end:

    sudo service sandstorm start-fe

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

## The Future

As of May 2014, sandboxed apps can receive and respond to HTTP and WebSocket requests from users
of the Sandstorm shell interface. That's it. This is enough for document-editor-type apps, but
not anything that needs to interact with the world.

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
* Blogging.
* RSS readers.
* Media storage and playback.
* Most importantly:  Things that we don't expect!

Have a great idea for an app? [Share it with us](https://groups.google.com/group/sandstorm-dev), and we'll help you figure out how to make it fit in Sandstorm.

## Contribute

Want to help?  Get on the [discussion group](https://groups.google.com/group/sandstorm-dev) and let us know!
