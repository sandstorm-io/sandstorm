# vagrant-spk design document

This page documents the initial design goals of
`vagrant-spk`. Therefore it is a statement of _hope_, not a statement
of _fact._ Given that, please take it with a pinch of salt.

You can find the current implementation at
[sandstorm-io/vagrant-spk](https://github.com/sandstorm-io/vagrant-spk).

## About vagrant-spk

`vagrant-spk` is a tool that makes it easy to take a web application
that runs on Linux and make a Sandstorm package from it. It is called
`vagrant-spk` because it relies on Vagrant, a tool that makes it
(supposedly) easy to create disposable virtual Linux systems.

`vagrant-spk` emphasizes:

* **Clear process**: This documentation should serve as a clear guide for how to package an app for Sandstorm. The purpose of each step should be clear, and it should be easy to debug problems.
* **Support for many platforms**: Packaging an app for Sandstorm with `vagrant-spk` should work properly on Windows, Mac, and Linux.
* **Useful defaults, with deviation possible**: If the tooling can choose a default that is likely to work for people, it does so; it also documents how to make a different choice if you have to.
* **Re-usability**: The work that you do to package the app should be usable by other people, and it should be useful to you when you need to upgrade the app to its latest version.
* **Humility**: `vagrant-spk` is a convenience tool, but nothing in it a _core_ part of Sandstorm. Therefore, if other people come up with a better tool for creating SPKs, it will be possible for that future tool to take over the ecosystem.

To package an app for Sandstorm with `vagrant-spk`, you will need to follow these steps:

* Install `vagrant-spk`, so that it is on your $PATH.
* Install Vagrant on your system.
* Run `vagrant-spk setupvm lemp` within the app's main source tree, to create template files that will be used by the packaging process.  'lemp' here refers to a particular software stack (linux/nginx/mysql/php) that should be run in the package; we may add support for other stacks in the future.
* Run `vagrant-spk vm up` from the same folder to launch the VM, install a developer-mode Sandstorm instance, and install and configure nginx/php/mysql for the app.
* Run `vagrant-spk init` to create a `sandstorm-pkgdef.capnp` file describing the app.  Modify it to correct things like e.g. app name and action text.
* Get your app ready for the Sandstorm sandbox. This will mean ensuring the app runs properly at all.
* Run `vagrant-spk dev` to verify if the app runs within Sandstorm. If not, loop back to "Get your app ready".
* Run `vagrant-spk pack` to create an SPK file, containing your app and all its dependencies.
* Distribute your SPK file to yourself (on your own Sandstorm instance) and (optionally) add it to the Sandstorm App List.
* Optional, but recommended: Push the files created by `vagrant-spk` into version control.

Right now, `vagrant-spk` is built primarily with PHP/MySQL apps in
mind. We hope to enhance it over time to work for a wider variety of
apps.

To read how to package a sample PHP/MySQL app for Sandstorm, read the
[five minute packaging tutorial](packaging-tutorial.md).

## Installation plans

How are Windows people going to execute a shell script?

Then again, should we grow up and make it a Python script (and
probably limit its dependencies to the Python standard library)? If
so, then we can use e.g. py2exe and make it a single EXE file that you
place somewhere that's always on the %PATH%.

We could write it in Go. Hmm. Or we could write it in C++. Or we could
write it in JavaScript and for Windows convenience, use JSDB:
http://jsdb.org/ which allows

Turns out NSIS offers a way to modify %PATH%, if we need to go down that road:

* http://nsis.sourceforge.net/Path_Manipulation
* https://stackoverflow.com/questions/11272066/nsis-how-to-set-an-environment-variable-in-system-variable

# Create packaging template files, with vagrant-spk init

If you see the following instead:

```
$ ls index.*
ls: cannot access index.*: No such file or directory
```

You probably need to use `cd` to switch into the directory containing the app you want to package.

## Original proposed result of vagrant-spk init

```
$ vagrant-spk init
```

It will create the following files, which you will customize over the course of this guide.

* `.sandstorm/Vagrantfile` - This file contains information defining a virtual machine.
* `.sandstorm/provision.sh` - This file contains commands to run when creating the virtual machine. You'll customize it below if needed.
* `.sandstorm/sandstorm-pkgdef.capnp` - This file contains information about the package, such as its name.
* `.sandstorm/sandstorm-files.list` - This is a list of all the files from the operating system that will become part of the SPK.

If you have a `.gitignore` file, it will add these lines to it:

```
.sandstorm/on-instance-start-initial-var/
.sandstorm/tmp/
.sandstorm/build-result/
```

Feel free to add all these changes into git, if you like, and commit.

## Start a virtual machine to run your app

### Click around to do setup tasks

Some PHP/MySQL apps require manual interaction with their web interface to set up a config file and sample data. Now is a good time to do those tasks.

## Get your app ready for the Sandstorm sandbox

### Overview

When a user of an app starts an instance in Sandstorm, Sandstorm does the following:

* Unpack the contents of the SPK into a new directory.
* Start a fresh container with the SPK content mapped in _read-only_.
* Create an empty directory at `/var` specific to this one instance.
* _Prepare the instance_ by running all the scripts, if any, in the `.sandstorm/on-instance-create.d/` directory. By default, this also includes copying the contents of `.sandstorm/on-instance-start-initial-var/` into `/var`.
* _Run the app_ by running all the scripts in the `.sandstorm/on-instance-start.d/` directory.
* _Provide HTTP headers_ indicating user identity and access level to the app. (See the separate doc on [User Authentication](User-Authentication) on the topic.)

(If you are curious, some of this infrastructure is built-in to Sandstorm, and some is provided by `vagrant-spk`; see also `.sandstorm/sandstorm-pkgdev.capnp` to learn more about the boundary.)

Therefore, you will need to create a snapshot of `/var` that is loaded into each app instance. The steps below indicate how to do that.

### Steps

To improve clarity, let's temporarily stop the nginx and mysql services. (The easiest way to get them back is to run `vagrant reload`, which reboots the Linux virtual machine and starts all services that would normally auto-start.)

To do that, run the following from the `.sandstorm` directory:

```
$ vagrant ssh
$ sudo service nginx stop
$ sudo service mysql stop
```

To verify that nginx has truly stopped, visit http://localhost:8000/ in your browser now. You will notice that your browser shows you an error page, whereas earlier it showed the app you were packaging.

If your app needs data in `/var` to run properly -- for example, if it needs a MySQL or sqlite database that you have already created -- you can copy that into the `.sandstorm/on-instance-start-initial-var/` directory with the following commands:

```
$ rsync -av /var/. /opt/app/.sandstorm/on-instace-start-initial-var/
```

That should be all you need to do within while logged into the virtual machine. So you can run this command to go back to leave the `vagrant ssh` session.

```
$ exit
```

Make sure you are in the `.sandstorm/` directory, then run:

```
$ vagrant-spk dev
```

This will do the following:

* Start Sandstorm within the Vagrant box, and
* Make your app available to it.

So now if you visit http://local.sandstorm.io:6080/ , you should see the ability to start an instance of your app.

Does it work properly? Great! Try a second instance!

At this point, you might notice that the button to start an instance of your app is labeled "New Sample App". You probably want to change the name from "New Sample App" to something better by editing `.sandstorm/sandstorm-pkgdev.capnp`.

Note that it's _essential_ that you try out the app during this phase. Sandstorm emphasizes small SPK files, and we achieve this by tracing the app when `spk dev` is running, storing a list of files the app truly access. You can feel comfortable knowing that none of your personal files are available within the Vagrant virtual machine, so none of your personal files will be embedded in the SPK file.

Now, quit `vagrant-spk dev` by typing `Ctrl-C` on your keyboard. The tooling will generate a `.sandstorm/sandstorm-files.list` that you can inspect.

## Create the SPK file, with vagrant-spk pack

Finally, you can pack all the files of your app and the operating system components that it used by running this command:

```
$ vagrant-spk pack
```

This creates a file called:

```
.sandstorm/build-result/package.spk
```

You can add this to your own Sandstorm server, or upload it to your web hosting and ask us to add it to the Sandstorm App List.

## Distribute the SPK file!

Distribute your SPK file to yourself (on your own Sandstorm instance) and (optionally) add it to the Sandstorm App List.

## Add these files to version control

Optional, but recommended: Push the files created by vagrant-spk into version control.

## Back up your key

Always a good idea.

## Known ways to improve this

* Document how to handle the MySQL content specifically, and what MySQL username/password the app should use. The general plan is:
   * Pre-install MySQL, and have a hard-coded username & password that apps should use, and
   * Tell people to rsync the MySQL data into the var snapshot directory, so that there is a clear moment where they do that snapshotting (and therefore they know how to modify it).
