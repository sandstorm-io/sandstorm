# How It Works

* Sandstorm's server-side sandboxing is based on the same underlying Linux kernel features as LXC and Docker.  We use the system calls directly for finer-grained control.
* (Planned) The kernel attack surface is reduced using seccomp-bpf to block and/or virtualize system calls.
* procfs, sysfs, etc. are not mounted in the sandbox, and only a minimal set of devices are available.
* (Planned) On the client side, apps run in a sandboxed iframe employing the `Content-Security-Policy` header to prevent them from sending any kind of network communication to any server other than their own.
* All communication between the sandboxed server and the outside world takes place through a single [Cap'n Proto](http://capnproto.org) RPC socket which the app's root process receives as file descriptor #3.  We've provided a program, `sandstorm-http-bridge`, which can receive HTTP-over-RPC requests on this socket and proxy them to a regular HTTP server running in the sandbox.
* Every object (e.g., each document) that you create with an application runs in a separate isolated sandbox.  We sandbox per-object rather than per-app so that it is easy and safe to share one object without also sharing everything created using the same app.
* An application package (`.spk` file) is essentially an archive containing an entire chroot environment in which the application runs.
* The application runs with the contents of its package mounted read-only, so that multiple instances of the same app can share disk space for the package.
* The application may store persistent state in the `/var` directory.
* App servers are aggressively killed off as soon as the user closes the browser tab, then restarted when the user returns later.
* Packages are cryptographically signed.  Packages signed with the same key represent versions of the same app, and are thus allowed to replace older versions -- although the user must still confirm these upgrades.
