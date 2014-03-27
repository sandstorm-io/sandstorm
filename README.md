# Sandstorm

* [Introduction](#introduction)
* [Caveats](#caveats)
* [Prerequisites](#prerequisites)
* [Building / installing the binaries](#building--installing-the-binaries)
* [Running the shell](#running-the-shell)
* [How it Works](#how-it-works)
* [How to Port Apps](#how-to-port-apps)
* [The Future](#the-future)
* [Contribute](#contribute)

## Introduction

See:  [sandstorm.io](http://sandstorm.io)

## Caveats

### *WARNING! WARNING!*

Sandstorm is in the very early stages of development.  We want developers to start playing with it, but keep some things in mind:

* At present, Sandstorm's sandboxing is incomplete.  Malicious code probably can escape.  Malicious code _definitely can_ DoS your server by consuming all available resources.
* The sharing model is very primitive right now.  Simply copy/paste an app instance link to share it with others.
* The UI stinks.  We're working on it.
* Apps can't do a whole lot yet, since we don't have many APIs to interact with the outside world.  See our [future plans](#the-future) and [let us know](https://groups.google.com/group/sandstorm-dev) what we should build next!
* The API (what there is of it) is not final.  It could change in a way that breaks existing apps.

## Prerequisites

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

## Building / installing the binaries

    make
    sudo make install SANDSTORM_USER=$USER:$USER

You should replace `$USER:$USER` with the user:group pair under which the sandstorm shell will run.  The above is appropriate if you want to run it as yourself.

Note that the binary `sandstorm-supervisor` is installed setuid-root.  This is necessary because the Linux kernel sandboxing features are only available to root (except on very new kernels with UID namespaces which Sandstorm doesn't yet use).  This program is believed to be safe, but in this early stage it may be advisable not to install sandstorm on a system where malicious users may have shell access.

## Running the shell

    cd shell
    mrt install
    meteor

Now connect to: http://localhost:3000

On first run, you'll have to configure some things:
* Configure the login system, by clicking the "sign-in" link in the upper-right and following the directions.
* Sign in.
* In a new terminal window, `cd` to the `shell` directory and run `meteor mongo`.
* Run the Mongo command: `db.users.update({}, {$set: {isAdmin: true}})`  This makes you (and anyone who has signed in so far) an administrator.
* `exit` out of the Mongo shell.
* Browse to `/signup-mint` on your server.
* Create a new invite key.
* Click on it yourself.  This gives you permission to install apps.
* [Install some apps](http://sandstorm.io/apps)

You can create more invite keys to distribute to other people who will share your server.  Keep in mind that currently there are no resource quotas, so anyone you give access will be able to fill up your hard drive and use all your CPU and RAM.  Therefore, it's a good idea only to invite friendly people for now.

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

### Step 1:  Create a chroot environment

You need to create a chroot environment containing everything your server needs to run.  That is, you want to create a directory that contains essentially a minimal Linux directory tree, such that if that tree were your root directory, you'd have everything you need.

There are many ways to do this, and this document can't cover all the details.  A popular approach used with e.g. Docker is to actually use the package manager of a distribution like Debian or Ubuntu to install a minimal set of packages into a specified directory.  However, this will tend to give you more than you need, as these distributions are designed to support things like shell access and user login.

I've had success with a more basic approach:

* Find your server binary -- e.g. if you are using node.js, find the `node` binary -- and copy that into the chroot, in the same relative position as it appears on your own filesystem.
* Use `ldd` to determine the library dependencies of your binary and copy each of those over as well.
* Figure out where your programming language puts libraries or modules and copy all those over.
* If you need to run any shell scripts (e.g. to start up your server), put a copy of [Busybox](http://www.busybox.net/) at `bin/sh`.  You can also symlink the names of common commands (e.g. `ls`) to this binary, but that's usually not necessary as any shell script you run will be running under busybox's shell anyway, which automatically uses its built-in version of each command.
* Once you think you have everything, use the `chroot` command to enter the chroot and try to run your server.  It probably won't work the first time, but hopefully the error message will tell you what you missed.

Note:  Remember that if you distribute your package, you are responsible for complying with the license terms of all software you've put in it.

**MongoDB Note:**  If your app uses MongoDB, please use [Kenton's fork](https://github.com/kentonv/mongo/tree/niscu) rather than the original Mongo.  Mongo is optimized for huge databases, but Sandstorm grains should be tiny.  Kenton's fork changes some hard-coded constants to make that possible.  Eventually we'd like to get this merged upstream in some form but there's no timeline for that happening.

Other databases may have similar problems.  Check disk usage under `/var/sandstorm/grains` to make sure your app's grains are of reasonable size.

### Step 2:  Create the placeholder directories

Run `mkdir dev tmp var` in your chroot directory.

Leave these directories empty.  The system will populate them when starting up the sandbox.  `dev` will contain only the devices `null`, `zero`, and `urandom`.  `tmp` will be a temp dir which is wiped every time your app restarts.  `var` will be the place where you want to write persistent state.  Note that `tmp` and `var` will be the _only_ writable locations in the filesystem inside the sandbox, so be careful to target your storage there.

### Step 3:  Add legacy-bridge

Your app will talk to the rest of the world through Cap'n Proto RPC.  However, if you are porting an existing web app, chances are it is currently designed respond to plain old HTTP.  The Sandstorm source code includes a program called `legacy-bridge` to help bridge the two.  You should copy this program into the root of your source tree, and then use it as the main program of your app.  `legacy-bridge` will run some other program you specify as a child process and then forward HTTP requests to it on a given port.  Run `legacy-bridge --help` for more information.

Note that `legacy-bridge` is not installed by `make install`, since it is meant to be included in app packages.  You can find it in the `bin` directory of the source tree after running `make`.

### Step 4:  Add a manifest

The package manifest contains metadata about the app, such as it's title and the hooks it installs into the Sandstorm menus.  Most importanly, though, the manifest describes how to start the app.

The manifest is a [Cap'n Proto](http://capnproto.org) structure.  The schema is defined in `package.capnp`, named `Manifest`.

The manifest file you include in your package is in Cap'n Proto binary format.  You can create the manifest file using the `capnp` tool's `eval` command.  For example, define a file like this:

    @0xf1ddb6d3b831f794;  # Generate with `capnp id`

    using Package = import "/sandstorm/package.capnp";

    const manifest :Package.Manifest = (
      # Increment this whenever you distribute a new update to users.
      # Sandstorm will know to replace older versions of the app.
      appVersion = 0,
      
      actions = [(
        # Defines a "new document" action to add to the main menu.
        input = (none = void),
        title = (defaultText = "New Widget"),
        
        # This command will run when a new instance of the app
        # is created after the user clicks on "New Widget".
        command = (
          executablePath = "/legacy-bridge",
          args = ["127.0.0.1:8080", "/run-first-time.sh"]
        )
      )],
      
      # This command runs when the user opens a pre-existing instance
      # of the app.
      continueCommand = (
        executablePath = "/legacy-bridge",
        args = ["127.0.0.1:8080", "/run-continue.sh"]
      )
    );

Note that in this example, we're using the `legacy-bridge` tool to launch our HTTP-based app.  In the example, the app runs on port 8080 and is started with the scripts `run-first-time.sh` or `run-continue` depending on whether we're initializing a fresh instance.  Change these as needed to match your app.

Now compile the manifest to create the binary file `sandstorm-manifest` at the root of your chroot tree:

    capnp eval -b manifest.capnp manifest > my-pkg/sandstorm-manifest

### Step 5:  Create a signing key

Every package must be cryptographically signed.  The purpose of signing a package is to authenticate that updates to the app came from the same source.  Sandstorm assumes any two packages signed with the same key represent versions of the same app.

    spk keygen secret.key

Keep `secret.key` in a safe place, preferably offline.  DO NOT INCLUDE IT IN YOUR APP PACKAGE OR PUT IT ON GITHUB.

### Step 6:  Build the package

    spk pack my-pkg secret.key

This creates `my-pkg.spk`, ready for distribution.

### Step 7:  Upload

Go to `/install` at your sandstorm host and upload the package through the web form there.

If you make your app accessible at an HTTP URL, you may construct a link like:

    http://my-sandstorm-host/install/$HASH?url=$URL

Replace `$HASH` with the first half of the SHA-256 hash of the package encoded in hex.  You can compute it like so:

    echo `sha256sum my-pkg.spk | head -c 32`

Note that once the package has been uploaded to a particular host, other users wishing to install the same package may omit the `?url=$URL` part of the link.  Or, put another way, when you upload via the `/install` web form, it will redirect you to `/install/$HASH`, and at that point you can simply copy-paste that URL to send to friends who use the same host.

### Step 8:  Debug

This is a bit hacky at the moment.

Your app's console output is stored to a log file that you can find at:

    /var/sandstorm/grains/$GRAINID/log

Also note that some error information -- especially relating to app installation failures and startup problems -- may appear on the Sandstorm server's own log (i.e. on the terminal where you run Meteor).

Obviously, you can only get at these logs if you have admin rights on the server.  We want to improve this soon, by providing some way to see app logs in the UI.

Another trick that can make iteration easier is to bypass the packaging process by editing your app directly in `/var/sandstorm/apps`.  This is where Sandstorm unpacks apps when they are installed.  The system does not verify that files haven't changed between runs, so you can update the files here and reload your app rather than repeatedly installing new packages.

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
