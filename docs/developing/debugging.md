To debug an app that is in dev mode, you can run a shell (e.g. `bash`) in the context of a grain
through the `vagrant-spk enter-grain` command. Using this shell can illuminate why an app is behaving in a
particular way.

## Overview and limitations

Before using this procedure, you should know the following.

- **You get a shell within the grain.** This procedure gives you access to the filesystem and
  services (like MySQL) and other context of a grain.

- **Debugging tools from the Vagrant VM are mapped in**, so long as the app has `sourcePath = "/"`
  in the pkgdef, which most apps do. This allows you to use command-line tools from the Vagrant VM,
  such as `bash`, `sqlite3`, and `mysql`.

- **You must keep the grain open in a browser.** If the grain shuts down, your debug shell will stop
  working.

- **Dev mode only:** To get a shell against a grain, the grain must be running via `vagrant-spk dev`
  (or `spk dev`).

- **Incomplete sandboxing:** The shell currently bypasses Sandstorm's seccomp syscall filter. This
  may be fixed in a future version.

- **This will bloat your sandstorm-files.list,** unless you follow the workaround on this page. The
  commands you run in the shell will result in new files being accessed, and users don't need these
  debugging commands.

- **Command-line interface subject to change:** Changes may be necessary in the future to take
  advantage of changes in Sandstorm, or to make the tool easier to integrate into automation.

`vagrant-spk enter-grain` is a feature of `vagrant-spk`. If you are using [raw Sandstorm
packaging](../developing/raw-packaging-guide.md) without `vagrant-spk` then you can read the
`vagrant-spk` source code to see how to achieve the same thing.

## Steps

### Prepare a grain

Before starting, you must:

- Run `vagrant-spk dev` to make an app available in dev mode.

- Use your browser to navigate to an active grain.

It is **essential** to keep that grain open in your browser. This process attaches a debug shell in
the context of a running grain.

### Run vagrant-spk enter-grain

From a terminal, run:

```bash
vagrant-spk enter-grain
```

This will print a list of active grains in development mode, similar to the following.

```bash
This will run bash in the context of a grain. Here is a list of running grains you
can attach to. Press enter to choose the first one, or type the number next to the
grain ID to choose it.

1. AZzcygo2bGPJfw5AWvamhB

Your choice: [1]
```


You can **press enter** to accept the default, or type a number corresponding to a grain ID. This
will launch `bash` in the context of that grain, including the environment variables from the
`sandstorm-pkgdef.capnp`. You will see something resembling the following.

```
bash-4.3$
```

You can `cd` around, run command-line management utilities that are part of your app, and make Cap'n
Proto RPC calls if your app provides command-line tooling to do so. Once you are done, type `exit`
and press enter, or type Ctrl-D, to exit.

### Removing sandstorm-files.list bloat

Once you exit, you will see this message:

```
NOTE: You should discard all sandstorm-files.list changes from this session to avoid bloat!
```

By default, all the files that you use when the app is running are recorded by Sandstorm, and snce
you have run debugging tools in this session, the list of files will probably include files that
your users do not need.

To overcome that:

- **First, stop the `vagrant-spk dev` process.** The `sandstorm-files.list` file is updated when
  `vagrant-spk dev` terminates.

- **Second, clean or remove the files list.** Try `git checkout .sandstorm/sandstorm-files.list` to
  remove these changes. If you are not using git, or the command does not work, you can try
  executing `rm -f .sandstorm/sandstorm-files.list` instead.

If you do not do this, you would add debugging tools to the package that your users receive,
massively increasing the size of the SPK download.

## Tips on using the shell effectively

### Understanding the filesystem layout

The filesystem available in this shell is the same as the filesystem available within your grain.
You can find information on this in the `.sandstorm/sandstorm-pkgdef.capnp` file. As a reminder,
consider the following.

- `/` (read-only) contains all the files that could hypothetically go into your package. The bash process
  launched by `vagrant-spk enter-grain`shell starts in `/`.

- `/var` (read-write) contains the writable state for your app. This maps to
  `/opt/sandstorm/var/sandstorm/grains/{{grainId}}/sandbox` outside the grain.

If your `.sandstorm/sandstorm-pkgdef.capnp` contains a `sourcePath = "/"` line, which is the default
for all vagrant-spk platform stacks except the Meteor stack, then the full contents of the Vagrant
base box are available. If not, read below on how to add that.

`vagrant-spk` configures `.sandstorm/Vagrantfile` so that `/opt/app` (read-only within the grain) is
a shared folder to your host operating system, typically containing your app's source code. If your
app contains command-line tools, then you probably need to run this command before you can access
those tools.

```bash
cd /opt/app
```

### Overcoming missing command-line tools like ls

Some apps, especially those using Meteor platform stack for vagrant-spk, do not configure `sourcePath = "/"`,
so if you try to run some commands, you will get an error. For example:

```bash
$ ls
bash: ls: command not found
```

To work around this, you have three options.

**Option 1. Use debugging tools that are available.** For the Meteor stack in particular, you can
choose to run `node` instead, which provides a more Meteor-like experience while debugging. Here is
how you can launch node from `vagrant-spk enter-grain`.

```bash
$ vagrant-spk enter-grain
$ /bin/node
>   # you can now run whatever Javascript you wish
```

**Option 2. Inject the specific tools you need.** One good way to do this is to inject busybox into
the grain. To do that, you can run the following.

```bash
$ vagrant-spk vm ssh
$ sudo cp /bin/busybox /opt/sandstorm/var/sandstorm/grains/{{grainId}}/sandbox
```

Now, when you enter the grain, you can use busybox's bundled versions of ls, cp, and other typical
tools.

```bash
$ vagrant-spk enter-grain
$ ls
bash: ls: command not found
bash-4.3$ /var/busybox sh
$ ls  # will work now, since it comes from busybox
```

**Option 3. Make the full Linux VM filesystem available to the app.** Pro: You get the greatest
flexibility by having access to all commands installed within the vagrant-spk VM filesystem. Con:
These steps typically prevent `vagrant-spk pack` from working properly, so you will either need to
undo these changes once you are done debugging, or take further steps to make sure filesystem
tracing is properly enabled for your app.

In `.sandstorm/sandstorm-pkgdef.capnp`, look for the `sourceMap` section, whose first line will look
something like this.

```bash
  sourceMap = ...
```

Within that section, make sure that the root filesystem is available. You can add it by including
this snippet, typically as the first item in the list.

```bash
      ( sourcePath = "/" ),
```

Start `vagrant-spk dev` freshly, stopping it if required. You can do that by finding the terminal
window where you are running `vagrant-spk dev` and pressing Ctrl-C to terminate it. Then run it
again.

Now `vagrant-spk enter-grain` will work as normal for your app.

You should typically **undo this change to sourceMap before running spk pack**. If you retain these
changes, your package will probably fail to pack with a "permission denied" error, fail to include
all its files, be absurdly large, or include sensitive files. If the app does not include all its
files in the package, then when end-users run the SPK, the app will be broken. If the app is too
large, users will wait a long time to download the package. If you include sensitive files, you
might share your Sandstorm package's private keys, or other encryption keys like SSH or GPG keys,
resulting in anyone being able to take control of resources that belong to you. Therefore, we ask
you to please definitely **remove the new sourcePath when you are done debugging**.

It is possible to safely enable tracing for an app; if you want to do that, email the [sandstorm-dev
group](https://groups.google.com/forum/#!forum/sandstorm-dev) for help.

### Installing and using command-line debugging tools like MySQL client

For services like MySQL or sqlite3, the command-line debugging tool might not be currently installed
at the time when you want to debug the grain. In that case, you will see a message like this.

```bash
$ mysql
bash: mysql: command not found
```

You can install them in the Vagrant VM by running a command like this.

```
vagrant-spk vm ssh
sudo apt-get install mysql-client
```

It is possible (and often preferable) to run these tools outside the grain, **without vagrant-spk
shell**.  This has the advantage that it does not bloat sandstorm-files.list. As an example, to use
MySQL this way, you can run the following command.

```bash
vagrant-spk vm ssh
mysql -u root --socket /opt/sandstorm/var/sandstorm/grains/{{grainId}}/sandbox/run/mysqld/mysqld.sock
```

You can use similar commands to connect to any service that listens on a UNIX socket within the
grain. If the service uses a TCP socket, you will need to join the grain's network namespace,
which `vagrant-spk enter-grain` does.

### Using curl to send HTTP requests to the grain

You can use `vagrant-spk enter-grain` to make requests to your app from the command line. Here is an
example using curl. We use port 8000 because, by default, `.sandstorm/sandstorm-pkgdef.capnp`
connects to port 8000 within the grain.

```
$ curl http://127.0.0.1:8000/
```

Since you are operating inside the sandbox, you can add headers like `X-Sandstorm-User-Id` and
`X-Sandstorm-Permissions` headers. Here is an example using curl again.

```
$ curl -H 'X-Sandstorm-User-Id: 5e0d06fefb17f641093c4686cf1fe597' -H 'X-Sandstorm-Username: Alice%20Dev%20Admin' -H 'X-Sandstorm-Permissions: admin' http://127.0.0.1:8000/
```
