# Platform stacks

## About platform stacks

`vagrant-spk` includes support for a number of programming languages
and/or web frameworks, each of which have different practices on how
to go from the app's source code to a running web server.

The following stacks exist:

* `lemp`: a PHP-oriented software collection including nginx, MySQL, and PHP.
* `meteor`: a stack for [Meteor](https://meteor.com) apps, including MongoDB.
* `static`: `nginx` configured to serve static files from `/opt/app`.
* `uwsgi`: a Python-oriented stack including nginx and uwsgi.
* `diy`: Create your own.

Running this command:

```
vagrant-spk setupvm platformname
```

will set up a Linux virtual machine (with Sandstorm installed) ready to
run code in the platform called `platformname`.

This page contains **reference documentation** you might use after
having gone through the main [vagrant-spk packaging
tutorial](packaging-tutorial.md).

## DIY platform stack

`diy` in this platform stack stands for do-it-yourself. It provides
just the basic scripts, and requires you to fill in the
various `.sandstorm/` scripts.

This platform stack is for you if you want to package an app for
Sandstorm with `vagrant-spk` where there is no platform stack for
the framework/library/platform the app was written against, or if
you want a minimal platform stack because you know what you're doing.

See [Customizing & understanding vagrant-spk](customizing.md) for
details.

## Meteor platform stack

For a Meteor app, keep the following in mind:

* Get a copy of the app code wherever you like. Alternatively, run `meteor create --example todos`
* `cd` into that directory.
* Run `vagrant-spk setupvm meteor`
* Run `vagrant-spk vm up`. Note this will print _lots_ of red text; sorry about that, then abruptly end.
* Run `vagrant-spk init` and edit `.sandstorm/sandstorm-pkgdef.capnp`
* Run `vagrant-spk dev` and make sure the app works OK at http://local.sandstorm.io:6080/
* Run `vagrant-spk pack ~/projects/meteor-package.spk` and you have a package file!

**Troubleshooting**

If the app fails at the `vagrant-spk dev` step due to a packaging
error, you may need to:

```bash
meteor remove-platform ios
meteor remove-platform android
```

and then retry the `vagrant-spk dev` step.
