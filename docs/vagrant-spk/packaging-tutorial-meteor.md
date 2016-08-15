# Packaging tutorial (Meteor)

## Introduction

This tutorial will show you how to make a
[Sandstorm.io](https://sandstorm.io) package from a Meteor app.

**Compatibility note:** Sandstorm's Meteor tooling is currently compatible with Meteor 1.3.5.1
and earlier. If your app uses Meteor 1.4, you may need to wait until September 2016 for an
updated `vagrant-spk` that is compatible with Meteor 1.4.

Creating the package will take about five minutes of focused time,
interspersed with the downloading of various components, which can
take up to half an hour.

Look through the "Next steps" to learn more about how Sandstorm works
and how to integrate Sandstorm with the Meteor accounts system.

This tutorial assumes:

* You know the basics of Meteor and know how to open a terminal.

* You have a computer running Mac OS or Linux or Windows.

**Windows users, please note**: This tutorial should work for you, but
you might need to use slightly different commands to do things like
create directories. Contact community@sandstorm.io if you need help.

## Overview of Sandstorm packages

The tutorial uses a Meteor app as an example. **Sandstorm supports any
programming language that runs on Linux**, not just Meteor, such as
Python, Rails, Node, PHP, C++, Go, Rust, and more. Read about
[vagrant-spk's platform stacks](platform-stacks.md) to see how to
optimize your package for your app's programming language.

Once you've worked through this tutorial, look in the **Next steps** section
at the bottom of this document to learn more about how to improve the speed
of packaging on your computer, learn about user authentication and
permissions in Sandstorm, and more.

A Sandstorm application package ("SPK file" for short) includes all
the code needed to run your app, including all binaries, libraries,
modules, etc. Sandstorm relies on Meteor's `meteor build` system to
create the package.

Making a Sandstorm package enables people to:

* Create an instance of the app ("grain") with one click.

* Create a private grain of the app, secured by Sandstorm.

* Invite others to the grain through a Google Docs-like sharing
  interface.

* Trust that the data they enter into the app stays private to the
  app, due to Sandstorm's sandboxing.

Sandstorm packages rely on the Sandstorm platform to handle user login
and access control. You can read more in the [App Developer
Handbook](../developing/handbook.md). You can use an Atmosphere
package called
[kenton:accounts-sandstorm](https://github.com/sandstorm-io/meteor-accounts-sandstorm)
to integrate with that.

## Prepare the app

In this tutorial, we make a package for a web-based clock that is made
with Meteor. To create it, run the following commands:

```bash
mkdir -p ~/projects/sandstorm-packaging-tutorial
cd ~/projects/sandstorm-packaging-tutorial
git clone https://github.com/meteor/clock
cd clock
```

You now have a fully functional Meteor app stored in
`~/projects/sandstorm-packaging-tutorial/clock`.

**Note**: This is a regular Meteor app, so you can play with it
by running `meteor` and you can import it into git if you like.

## Set up for Sandstorm development

In this step, you will install the main Sandstorm app development
tool, a command-line tool called `vagrant-spk`.

That tool automates the process of creating a Linux virtual machine,
installing Sandstorm in the virtual machine, running your app in
Sandstorm, capturing its dependencies, and creating a package file you
can distribute so anyone with Sandstorm can see what you saw.

**Get your computer ready.** Follow the [vagrant-spk installation
guide](installation.md) before proceeding.

Once installed, you can use the `vagrant-spk` command to create a
Linux virtual machine. Make sure it's installed by running:

```bash
vagrant-spk --help
```

You should see a message like:

```bash
usage: /usr/local/bin/vagrant-spk [-h] [--work-directory WORK_DIRECTORY]
                                  {setupvm,up,init,dev,pack,publish,halt,destroy,global-status,ssh}
                                  [command_specific_args [command_specific_args ...]]
...
```

You need to install `vagrant-spk` just once, and you can use it to
create any number of Sandstorm packages.

## Start a virtual machine ready to run Sandstorm and Meteor

Sandstorm packages contain the full set of executable code required to
run an app on a Linux machine. `vagrant-spk` can prepare an isolated
environment with your app and its Meteor dependencies in order to
bundle them together into a Sandstorm package. The virtual machine it
creates runs Linux, which allows you to create packages that run on
Linux-based Sandstorm servers no matter what your main operating
system is.

To define a new machine to run your app inside, run this command:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk setupvm meteor
```

You should see a message like the following:

```bash
Initializing .sandstorm directory in /Users/myself/projects/sandstorm-packaging-tutorial/clock/.sandstorm
```

`vagrant-spk` stores packaging information in a `.sandstorm/`
directory within your app. The directory contains executable scripts
that define how the app is packaged as well as metadata like the
authors' names, the app's name, and icons for the app. We encourage
you to store this directory with the source code of your app; that
way, your colleagues can submit changes to the Sandstorm packaging.

Now switch the virtual machine on. This **will take a while**, perhaps
2-20 minutes the first time it boots, depending on your Internet
connection.

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk vm up
```

You will see a _lot_ of messages printed out. Some of them are not
necessary; we're working on tidying up the scripts to minimize the
noise.

Eventually, you will get your shell back. At this point, you can
continue to the next step.

**Troubleshooting note**: If the `vagrant-spk vm up` command fails, it
could be because you already have Sandstorm installed on your
laptop. You can recognize this error via the following red text:

```bash
Vagrant cannot forward the specified ports on this VM, since they
would collide with some other application that is already listening
on these ports. The forwarded port to 6080 is already in use
on the host machine.
```

If you see that, run:

```bash
sudo service sandstorm stop
```

and halt any other `vagrant-spk` virtual machines you might be using
to develop other apps.

## Connect your app to your local Sandstorm server

Apps run differently in Sandstorm, compared to `meteor deploy`, so
it's essential to preview what your app would look like when running
in Sandstorm. `vagrant-spk` helps you do this by providing a Sandstorm
server within a Linux virtual machine.

Before we can see the app in Sandstorm, it needs to have a package
definition file specifying the app's title and other metadata. Create
it with this command:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk init
```

<!-- Editor's note: In the future, we can blend `init` into `dev`. -->

This will create a `.sandstorm/sandstorm-pkdef.capnp` file, containing
some defaults.

Now make the app available to the Sandstorm server by running:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk dev
```

This step **can take some time** to download the Meteor dependencies
of the app.  Once it is done, you will see a message like:

```bash
App is now available from Sandstorm server. Ctrl+C to disconnect.
```

When we visit the Sandstorm server, we'll see the app available. Open up
this URL in your web browser:
[http://local.sandstorm.io:6080/](http://local.sandstorm.io:6080/)

A note about `local.sandstorm.io`: This is the same as `localhost`,
but in Sandstorm's security model, each session to the app uses a
temporary subdomain of the main Sandstorm URL. This is an
implemenation detail that your app mostly does not need to know about,
but it does mean that the domain name running Sandstorm needs
[wildcard DNS](../administering/wildcard.md). We created
`local.sandstorm.io` as an alias for `localhost` and gave it wildcard
DNS. You can rest assured that your interactions with
`local.sandstorm.io` stay entirely on your computer.

<!--(**Editor's note**: We should make localhost:6080 work, so that people don't have to learn about `local.sandstorm.io`.)-->

Take a moment now to sign in. Choose **with a Dev account** and choose
**Alice (admin)**. You will have to enter an email address; you can use
**alice@example.com**.

You should see an app in the apps list called **Example App**.

## Launch your app with one click

Sandstorm is a platform where users without technical knowledge can
launch instances of web apps, called "grains." To launch an instance
of the clock, click on the icon above **Example App**.

You'll now see a clock! It has the name **Untitled Instance**.

Sandstorm makes it easy to run multiple instances of an app; each one
is called a _grain_. Anyone with your app available on their Sandstorm
instance can create a new grain by clicking its icon.

You can test this out by going back to the **New** menu and creating
one or two more grains of the app right now. The **Open** menu enables
you to switch between different grains.

Sandstorm apps often need fewer lines of code than regular web
apps. They need to contain the web interface for creating exactly one
document, or editing just one image, or publishing one single
blog. Document management is delegated to Sandstorm.

Each grain runs totally isolated from other grains. For Meteor apps,
each grain has its own MongoDB server and database. Embedding the
database server into the package helps enforce isolation between app
instances: a crash or security issue in one grain doesn't affect
another grain. This also simplifies app packaging; it's OK to use use
the same database name for every grain.

**A word about Meteor, Sandstorm, and hot code push**: Each call to
`vagrant-spk dev` runs `meteor build`, which disables hot code push in
Meteor. To update the code you see in Sandstorm, you will need to stop
and start the `vagrant-spk dev` process. This is due to a technical
limitation in Sandstorm that we are working on addressing.

## Configure your app's name & other metadata

**Example App** is not a very descriptive name for this app, and **New
instance** is not a very descriptive name for a grain of this app. We
can do better.

This information is stored in
`.sandstorm/sandstorm-pkgdef.capnp`. `capnp` is the file extension for
[Cap'n Proto](https://capnproto.org/). For the purpose of this
tutorial, Cap'n Proto is a configuration file format that is easy for
Sandstorm to parse.

To change the title, open `.sandstorm/sandstorm-pkgdef.capnp` in a
text editor. Find the line with this text:

```bash
    appTitle = (defaultText = "Example App"),
```

Change it to the following.

```bash
    appTitle = (defaultText = "Analog Clock"),
```

We can change the text that Sandstorm users see when they want to
create a new _instance_ of the app. To do this, find the line
containing:

```bash
      ( nounPhrase = (defaultText = "instance"),
```

and change it to read:

```bash
      ( nounPhrase = (defaultText = "clock"),
```

To refresh the information that shows up in
[http://local.sandstorm.io:6080/](http://local.sandstorm.io:6080/),
find the terminal where you are running `vagrant-spk dev`. It should
have this line at the end.

```
App is now available from Sandstorm server. Ctrl+C to disconnect.
```

Hold the `Ctrl` key and tap `c` on your keyboard to get your
terminal back. Then re-start the process by running these
commands.

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk dev
```

This **may take a minute** while Meteor verifies it has downloaded all
your dependencies.

Now visit the the **New** menu. You should see that the app has a new
name -- **Analog Clock** -- and it allows you to make a **New clock**.

## Create an SPK package file

The artifact that Sandstorm app authors deliver to users is a
Sandstorm package (SPK) file, containing the app and all its
dependencies. The typical way to distribute this is via the [Sandstorm
app market](https://apps.sandstorm.io).

We'll build an SPK now. To do that, we must first stop the dev
server. To do that, open the terminal window containing the
`vagrant-spk dev` process and type `Ctrl-C` on your keyboard. You will
see some messages like:

```bash
Unmounted cleanly.
Updating file list.
```

Sandstorm stays running, and the app is now disconnected. If you're
still logged into your Sandstorm instance, you will notice the app
vanishing from the list of apps and your grains will become
broken. After we upload a Sandstorm package of the app, the grains
will heal themselves.

To create the SPK file, run:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk pack ~/projects/package.spk
```

This will take a few moments, and once it is done, there will be a
file in `~/projects/package.spk` that contains the full app.

You can see how large it is by running the following command:

```bash
du -h ~/projects/package.spk
```

In my case, I see:

```bash
21M     ~/projects/package.spk
```

This file size includes everything the app needs to run: its database
server, its libraries, and the Meteor app itself.

We can upload this app to our development Sandstorm server by visiting
the **New** tab and clicking **Upload app - choose SPK file**, and
then choosing this file in your web browser's upload dialog.

To learn how to go further and share this SPK file, or what you should know
for other web frameworks, check out the **What's next** section below.

<!--(**Editor's note**: IMHO vagrant-spk pack should auto-guess a reasonable package filename.)-->

## Clean up

With `vagrant-spk`, before you can develop a second app, you must stop
the virtual machine created as part of developing the first one.  This
is because the `vagrant-spk` virtual machine always uses port 6080.

In our case, we're done using the virtual machine running this app, so
it's safe to stop it. Run this command:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk vm halt
```

This shuts down the whole virtual machine used for developing your
app's Sandstorm package, including the Sandstorm install specific to
that app's packaging work. Now port 6080 is available for other app
packaging projects.

If you ever want to work on this app's packaging again, you can bring
it online by running:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk vm up
```

If you ever are confused about which Vagrant virtual machines are
running, run this command:

```bash
vagrant global-status
```

(**Note**: It's `vagrant` here, not `vagrant-spk`.)

# Next steps

Now that you've seen the basics of how a Sandstorm app works, you
might be interested in any of the following:

<!-- * How do I support users & access control? TODO FIXME Write something about this. -->
* What makes a great Sandstorm app? See the [App Developer Handbook](../developing/handbook.md).
* How do I learn more about the technical underpinnings of `vagrant-spk`? How do I make `vagrant-spk` faster?
Read about [understanding & customizing vagrant-spk](customizing.md).
* How do I package-up a Python, PHP, or other non-Meteor app? Read about [platform stacks](platform-stacks.md).
* Will this work on Windows? Yes, probably, but I use `~` and `mkdir -p` above, and you can't typically use those on Windows.
* Will this work on a cloud Linux instance? Probably not, since `vagrant-spk` creates a virtual machine and running a VM inside a VM often fails.
