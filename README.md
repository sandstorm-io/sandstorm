# Sandstorm

## Introduction

See:  [sandstorm.io](http://sandstorm.io)

## Prerequisites

Please install the following:

* Linux, with a reasonably recent kernel
* [Clang compiler](http://clang.llvm.org/) version 3.4 or better
* [Cap'n Proto](http://capnproto.org)
* [libsodium](https://github.com/jedisct1/libsodium)
* [Meteor](http://meteor.com)
* [npm](http://npmjs.org) module `es6-promise`

## Building / installing the binaries

    make
    sudo make install SANDSTORM_USER=$USER:$USER

You should replace `$USER:$USER` with the user:group pair under which the sandstorm shell will run.  The above is appropriate if you want to run it as yourself.

Note that the binary `sandstorm-supervisor` is installed setuid-root.  This is necessary because the Linux kernel sandboxing features are only available to root (except on very new kernels with UID namespaces which Sandstorm doesn't yet use).  This program is believed to be safe, but in this early stage it may be advisable not to install sandstorm on a system where malicious users may have shell access.

## Running the shell

    cd shell
    meteor

Now connect to: http://localhost:3000

On first run, you'll have to configure some things:
* Configure the login system, by clicking the "sign-in" link in the upper-right and following the directions.
* Sign in.
* In a new terminal, `cd` to the `shell` directory and run `meteor mongo`.
* Run the Mongo command: `db.users.update({}, {$set: {isAdmin: true}})`  This makes you (and anyone who has signed in so far) an administrator.
* `exit` out of the Mongo shell.
* Browse to `/signup-mint` on your server.
* Create a new invite key.
* Click on it yourself.  This gives you permission to install apps.
* [Install some apps](http://sandstorm.io/apps)

You can create mone invite keys to distribute to other people who will share your server.

If you don't want to run the shell in developer mode, read up on how to deploy Meteor apps.  Keep in mind that the `spk` and `sandstorm-supervisor` binaries must be available in the `PATH` wherever the shell runs.
