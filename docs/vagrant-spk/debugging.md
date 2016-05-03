For debugging an app that is in dev mode, you can run a shell (e.g. `bash`) in the context of a
grain. Using this shell can illuminate why an app is behaving in a particular way.

## Limitations

Before using this procedure, you should know about the following limitations.

- This procedure gives you access to the filesystem and services (like MySQL) and other context of a
  grain. However, because `nsenter` does not clone a process's seccomp context nor Linux
  "capabilities", it is not a perfect simulation. For example, the commands that you run in the
  shell can use Linux syscalls that the grain is not able to use.

- Under some circumstances, especially for Meteor apps, the shell itself may be missing! Read on for
  a workaround.

- This procedure relies on the grain staying alive while you debug it. Therefore, you must keep a
  browser tab open to the grain during this process.

- This procedure requires that a grain be running in **dev mode**. Read on for how to use this, with
  some effort, to debug a grain that is failing in production.

- This process will **bloat your sandstorm-files.list**. Read on to see how to handle that.

- This is a feature of `vagrant-spk`. If you are using raw Sandstorm packaging without `vagrant-spk` then
  you can read the `vagrant-spk` source code to see how to do the same thing.

## Steps

If a Sandstorm is app is currently available in dev mode (i.e., you are running `vagrant-spk dev`),
and you have a grain open, you can copy its grain ID from the address bar of your browser.