# Packaging tutorial (Meteor)

Style: Hands-on introductory tutorial.

This tutorial will show you how to package a Meteor app for
[Sandstorm](https://sandstorm.io) in five minutes. Going through this
tutorial, you'll learn:

* How to take an existing Meteor application and turn into a Sandstorm
  package (SPK).

* How our packaging helper (`vagrant-spk`) lets you edit the app's
  files on your main operating system (Mac or Linux), even though
  Sandstorm apps always run on Linux.

**Note for Windows users**: This tutorial should work for you, but you
might need to use slightly different commands to do things like create
directories. Contact community@sandstorm.io if you need help.

The tutorial uses a Meteor app as an example. **Sandstorm supports any
programming language that runs on Linux**, not just Meteor, such as
Meteor, Python, Rails, Node, PHP, C++, Go, Rust, and more. Read about
[vagrant-spk's platform stacks](platform-stacks.md) to see how to
optimize your package for your app's programming language.

Once you've worked through this tutorial, look in the **Next steps** section
at the bottom of this document to learn more about how to improve the speed
of packaging on your computer, learn about user authentication and
permissions in Sandstorm, and more.

## Overview of Sandstorm packages

A Sandstorm application package includes all the code needed to run
your app, including all binaries, libraries, modules, etc. Sandstorm
relies on Meteor's `meteor build` system to create the package.

Making a Sandstorm package enables people to:

* Create an instance of the app ("grain") with one click.

* Create a private grain of the app, secured by Sandstorm.

* Invite others to the grain through a Google Docs-like sharing
  interface.

* Trust that the data they enter into the app stays private to the
  app, due to Sandstorm's sandboxing.

Sandstorm packages rely on the Sandstorm platform to handle adding new
user accounts and other access control elements. You can read more in
the [App Developer Handbook](../developing/handbook.md). For Meteor,
there is a custom accounts add-on you can use for this.

## Before proceeding, install vagrant-spk

Make sure you've worked through the
[vagrant-spk installation guide](installation.md) before going through this tutorial!

# Creating a package

Over the course of section, we will use `vagrant-spk` to create a
Sandstorm package containing the app and all its dependencies.

## Choose an app that you will package

In this tutorial, we make a package for a web-based clock that is made
with Meteor. To create it, run the following commands:

```bash
mkdir -p ~/projects/sandstorm-packaging-tutorial
cd ~/projects/sandstorm-packaging-tutorial
meteor create --example clock
```

The app's code will be stored at
`~/projects/sandstorm-packaging-tutorial/clock`.  We will spend the
rest of the tutorial in that directory and its sub-directories.

**Note**: So far, this is just a regular Meteor app! If you like to
use git, feel free to import it into git. Feel free to check out
the `*.js` files that Meteor has generated for you.

## View the app

You can start the Meteor clock by running:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
meteor
```

If you visit http://localhost:3000/, you can view the clock!

## Create .sandstorm, to store packaging information for the app

Over the rest of this tutorial, we will prepare a `.sandstorm/`
directory for the project. This directory contains the Sandstorm
packaging information, such as the app name and Sandstorm metadata
about how to run a Meteor app.

We'll use the `vagrant-spk` tool to create this directory.

The purpose of `vagrant-spk` is to create a Linux system where
Sandstorm and your app run successfully. It acts differently based on
which _language platform_ you want to use. In our case, we'll use the
_meteor_ platform stack.

To do that, run the following commands:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk setupvm meteor
```

You should see a message like the following:

```bash
Initializing .sandstorm directory in /Users/myself/projects/sandstorm-packaging-tutorial/clock/.sandstorm
```

You should also find that the `.sandstorm/` directory now exists in your project.
Here's how you can take a look:

```bash
ls ~/projects/sandstorm-packaging-tutorial/clock/.sandstorm
```

## Start a virtual Linux machine containing Sandstorm

To get the benefits of Sandstorm, an app must be running inside
Sandstorm. So let's launch the app inside Sandstorm.

The `.sandstorm/` directory now specifies how to create a Linux
virtual machine containing Sandstorm and your app. To start
the machine, run the following command:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk up
```

You will see a _lot_ of messages printed out. Some of them are not
necessary; we're working on tidying up the scripts to minimize the
noise.

Eventually, you will get your shell back. At this point, you can
continue to the next step.

**Troubleshooting note**: If you already have Sandstorm installed on
your laptop, you might see the following red text:

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

and halt any other `vagrant-spk` virtual machines you might be using to develop
other apps.

## Examine the Sandstorm instance you will develop against

Your system is now running a Sandstorm instance. You should visit it
in your web browser now by visiting

http://local.sandstorm.io:6080/

(`local.sandstorm.io` is an alias for `localhost`.)

Take a moment now to sign in by clicking on **Sign in** in the top-right corner.
Choose **Sign in with a Dev account** and choose **Alice (admin)** as the user
to sign in with.

Note that there are other "dev accounts" available -- you can use this to test
the experience of using your app as other users.

Your app doesn't show up in this Sandstorm instance yet. We'll fix
that over the next two steps.

<!--(**Editor's note**: We should make localhost:6080 work, so that people don't have to learn about `local.sandstorm.io`.)-->

## Configure your app's name & other metadata in sandstorm-pkgdef.capnp

Every Sandstorm package needs to declare its name. It does this in a
`sandstorm-pkgdef.capnp` file. (`capnp` is short for Cap'n Proto; for
the purpose of this tutorial, Cap'n Proto is a configuration file
format that is easy for Sandstorm to parse.)

Let's use `vagrant-spk` to initialize your  definition file by running:

```bash
vagrant-spk init
```

(You should be running it from the `~/projects/php-app-to-package-for-sandstorm` directory.)

This will create a new file called `.sandstorm/sandstorm-pkdef.capnp`.

We'll make two changes. First, we'll give our app a **title** of
_Sandstorm Showcase_. To do that, open `.sandstorm/sandstorm-pkgdef.capnp` in
a text editor and find the line with this text:

```bash
    appTitle = (defaultText = "Example App"),
```

Change it to the following.

```bash
    appTitle = (defaultText = "Sandstorm Showcase"),
```

Second, we will customize the text that Sandstorm users see when they want
to create a new _instance_ of the app. To do this, find the line containing:

```bash
      ( title = (defaultText = "New Instance"),
```

and change it to read:

```bash
      ( title = (defaultText = "New Showcase"),
```

## Make the app available in the Sandstorm in development mode

Now let's make your app show up in the list of apps on this server.
Run this command:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk dev
```

On the terminal, you will see a message like:

```bash
App is now available from Sandstorm server. Ctrl+C to disconnect.
```

Now you can visit the Sandstorm at http://local.sandstorm.io:6080/ and
log in as **Alice (admin)**. Your app name should appear in the list
of apps.

You can click **New Showcase** and see the Meteor code running.

Note that each app instance (each "Showcase", for this app) runs
separate from each other. You can see that for this app because the
app stores the number of times you have reloaded the page. If you
create another **New Showcase**, each instance will store their data
separately.

In Sandstorm, resources like a database are embedded into the
package. That helps enforce this isolation between app instances.

**Note for Meteor**: `vagrant-spk dev` runs a `meteor build`, so if
you make code changes to your Meteor app, you will need to stop and
start the `vagrant-spk dev` to update the code you see in Sandstorm.

## Stop the development server and create a package file

In Sandstorm, the artifact that app authors deliver to users is a
Sandstorm package (SPK) file, containing the app and all its
dependencies. The typical way to distribute this is via the [Sandstorm
app market](https://apps.sandstorm.io).

To build the SPK, we must first stop the dev server. To do that, type
`Ctrl-C` on your keyboard. You will see some messages like:

```bash
Unmounted cleanly.
Updating file list.
```

If you're still logged into your Sandstorm instance, you will notice the app
vanishing from the list of apps on the left.

To create the SPK file, run:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk pack ~/projects/package.spk
```

This will take a few moments, and once it is done, there will be a file in
`~/projects/package.spk` that contains the full app.

You can see how large it is by running the following command:

```bash
du -h ~/projects/package.spk
```

Now, you can upload this to your development Sandstorm instance by clicking
**Upload app* and choosing this file in your web browser's upload dialog.

To learn how to go further and share this SPK file, or what you should know
for other web frameworks, check out the **What's next** section below.

<!--(**Editor's note**: IMHO vagrant-spk pack should auto-guess a reasonable package filename.)-->

## Stop the virtual machine running your app and Sandstorm

With `vagrant-spk`, before you can develop a second app, you must stop
the virtual machine created as part of developing the first one.  This
is because the `vagrant-spk` virtual machine always uses port 6080.

In our case, we're done using the virtual machine running this app, so
it's safe to stop it. Run this command:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk halt
```

This shuts down the whole virtual machine used for developing your
app's Sandstorm package, including the Sandstorm install specific to
that app's packaging work. Now port 6080 is available for other app
packaging projects.

If you ever want to work on this app's packaging again, you can bring
it online by running:

```bash
cd ~/projects/sandstorm-packaging-tutorial/clock
vagrant-spk up
```

If you ever are confused about which Vagrant virtual machines are
running, you can try this command:

```bash
vagrant global-status
```

(**Note**: It's `vagrant` here, not `vagrant-spk`.)

# What's next

Now that you've seen the basics of how a Sandstorm app works, you
might be interested in any of the following:

<!-- * How do I support users & access control? TODO FIXME Write something about this. -->
* What makes a great Sandstorm app? See the [App Developer Handbook](../developing/handbook.md).
* How do I learn more about the technical underpinnings of `vagrant-spk`? How do I make `vagrant-spk` faster?
Read about [understanding & customizing vagrant-spk](customizing.md).
* How do I package-up a Python, PHP, or other non-Meteor app? Read about [platform stacks](platform-stacks.md).
* Will this work on Windows? Yes, probably, but I use `~` and `mkdir -p` above, and you can't typically use those on Windows.
* Will this work on a cloud Linux instance? Probably not, since `vagrant-spk` creates a virtual machine and running a VM inside a VM often fails.
