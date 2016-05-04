For debugging an app that is in dev mode, you can run a shell (e.g. `bash`) in the context of a
grain. Using this shell can illuminate why an app is behaving in a particular way.

## Overview and limitations

Before using this procedure, you should know the following.

- This procedure gives you access to the filesystem and services (like MySQL) and other context of a
  grain.

- It allows you to use debugging tools from the Vagrant VM, such as `bash`, `sqlite3`, and `mysql`.

- However, it will fail for the Meteor `vagrant-spk` stack because it relies on `spk dev` tracing;
  keep reading for a workaround.

- The shell you run is not as constrained as the grain; this only matters under rare
  circumstances. For example, the commands that you run in the shell can use Linux syscalls that the
  grain is not able to use.

- This procedure relies on the grain staying alive while you debug it. Therefore, you must keep a
  browser tab open to the grain during this process.

- This document assumes that a grain is running in **dev mode**.

- This process can **bloat your sandstorm-files.list** if you do not accept the defaults.

- This is a feature of `vagrant-spk`. If you are using raw Sandstorm packaging without `vagrant-spk`
  then you can read the `vagrant-spk` source code to see how to do the same thing.

## Steps

### Prepare a grain

Before starting, you must:

- Run `vagrant-spk dev` to make an app available in dev mode.

- Use your browser to navigate to an active grain.

It is **essential** to keep that grain open in your browser. This process attaches a debug shell
in the context of a running grain.

### Run vagrant-spk devjoin

From a terminal, run:

```bash
vagrant-spk devjoin
```

This will print a list of active grains in development mode, similar to the following.

```
This will run bash in the context of a grain. Here is a list of running grains you
can attach to. Press enter to choose the first one, or type the number next to the
grain ID to choose it.

1. AZzcygo2bGPJfw5AWvamhB

Your choice: [1]
```

Press **enter** to accept the choice. You should now see a shell prompt like the following.

```
I have no name!@sandbox:/$ 
```

(You can ignore the `I have no name!` message.)

This is a `bash` shell. You can run other commands within it, or type `exit` (or ctrl-d) to exit.

Once you exit, you will see this message:

```
WARNING: You should discard all sandstorm-files.list changes from this session to avoid bloat!
```

Since you have run debugging tools in this session, all the files you used during debugging would
be added to the Sandstorm package. When you eventually stop the `vagrant-spk dev` server, you should
run:

```bash
rm -f .sandstorm/sandstorm-files.list
```

or, if you are using git, and already have a valid file list:

```bash
git checkout .sandstorm/sandstorm-files.list
```

If you do not do this, you would add debugging tools to the package that your users receive,
massively increasing the size of the SPK download.

### Filesystem layout and how to install debugging tools

The filesystem available in this shell is the same as the filesystem available within your grain.
You can find information on this in the `.sandstorm/sandstorm-pkgdef.capnp` file. As a reminder,
consider the following.

- `/opt/app` contains your app's code.

- `/var` contains the writable state for your app.

- `/` contains the full contents of the Vagrant base box, typically a Debian system.

To install new debugging tools, you run a command like:

```
vagrant-spk vm ssh
sudo apt-get install mysql-client
```

### Example explorations

You can use this to make requests to your app from the command line. Here is an example using curl.

```
$ curl http://127.0.0.1:8000/
```

Since you are operating inside the sandbox, you can add `X-Sandstorm-User-Id` and
`X-Sandstorm-Permissions` headers, and so forth. Here is an example using curl again.

```
$ curl -H 'X-Sandstorm-User-Id: 5e0d06fefb17f641093c4686cf1fe597' -H 'X-Sandstorm-Username: Alice%20Dev%20Admin' -H 'X-Sandstorm-Permissions: admin' http://127.0.0.1:8000/
```

You can also connect to the MySQL database within the grain by running the MySQL client. It will
connect as root with no password by default. From there, you can `SHOW DATABASES;` and perform other
operations.

```
$ mysql
```

## Overcoming limitations of the debug shell

### Handling missing tools like bash or ls

Some Sandstorm packages do not enable filesystem tracing. This includes all packages that use the
`meteor` platform stack from `vagrant-spk`.

For the Meteor stack in particular, you can choose to run `node` instead, which provides a more
Meteor-like experience while debugging. To do that, use this command: `vagrant-spk devjoin --command
/node`.

To get a shell in a grain that does not provide it, you can run:

```bash
vagrant-spk vm ssh
sudo apt-get install busybox-static
```

TODO manually test this etc.
