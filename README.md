# Sandstorm

Sandstorm makes it easy to run your own server.

Use Sandstorm to install apps to create [documents](http://etherpad.org/),
[spreadsheets](https://ethercalc.net/), [blogs](https://wordpress.org),
[git repos](https://about.gitlab.com/), [task lists](http://libreboard.com/),
and [more](https://sandstorm.io/apps/) as easily as you'd install apps on your
phone.

Sandstorm is open source and can be installed on any x86-64 Linux
system.

* Read more at: https://sandstorm.io/
* Try the demo: https://demo.sandstorm.io/
* Documentation available at: https://docs.sandstorm.io/

## Caveats

Sandstorm is in the very early stages of development. We want
developers to start playing with it, but please don't rely on it for
mission-critical data or security yet.

## Installing the Easy Way

*Prerequisite:* Linux x86_64, with kernel version 3.13 or later.

To install on your own Linux machine, do:

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

* Read more about installing Sandstorm: https://sandstorm.io/install/

### Tips

* If you want to run on port 80, we recommend setting up an [nginx](http://nginx.org/) reverse
  proxy rather than trying to get Node to open port 80 directly.  Make sure to configure
  [WebSocket forwarding](http://nginx.org/en/docs/http/websocket.html), which requires nginx
  1.3.13 or better.
* If you want SSL, then you will definitely need an nginx proxy (or something equivalent). You will
  further need to use a wildcard certificate.

For reference, [nginx-example.conf](nginx-example.conf) contains the http server part of nginx
config used by Sandstorm Alpha.

## Installing from Source (the hard way)

### Prerequisites

Please install the following:

* Linux x86_64, with kernel version 3.13 or later
* C and C++ standard libraries and headers
* GNU Make
* `libcap` with headers
* `xz`
* `zip`
* `unzip`
* `strace`
* `curl`
* discount (markdown parser)
* git
* [Clang compiler](http://clang.llvm.org/) version 3.4 or better
* [Meteor](http://meteor.com)

On Debian or Ubuntu, you should be able to get all these with:

    sudo apt-get install build-essential libcap-dev xz-utils zip \
        unzip strace curl clang discount git
    curl https://install.meteor.com/ | sh

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
whole bundle for every change. Do:

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

Read more in the [Sandstorm documentation](https://docs.sandstorm.io/en/latest/overview/).

## How to Package Apps

See [the packaging tutorial in the Sandstorm documentation](https://docs.sandstorm.io/en/latest/vagrant-spk/packaging-tutorial/).

## Contribute

Want to help?  Get on the [discussion group](https://groups.google.com/group/sandstorm-dev) and let us know!
