# Raw packaging guide

This tutorial will show you how to package an app for Sandstorm using
the raw `spk` tooling, helping you understand Sandstorm at a deeper
level.

**Note:** If you're new to Sandstorm packaging, or don't run Linux as
your main operating system, please read the [Five minute packaging
tutorial](../vagrant-spk/packaging-tutorial.md) first!

A Sandstorm application package includes the entire userspace needed
to run your app, including all binaries, libraries, modules,
etc. Normally, figuring out exactly what to put in a package could be
tedious. Sandstorm makes it easy by employing a trick: it watches your
server running on your development machine and pulls in all the files
the server uses.

Let's walk through an example.

(If you get stuck, see [Packaging Troubleshooting](troubleshooting.md).)

## Prerequisites

1. Learn about Sandstorm, if you haven't already.
  - [Try using Sandstorm](https://demo.sandstorm.io) to get a feel for how it operates.
  - [Read the App Developer Handbook](handbook.md) to understand the higher-level design issues faced by Sandstorm apps.

2. Install Sandstorm on your local machine.
  - Install Linux. Kernel version 3.13 or later. [Ubuntu](http://ubuntu.com) 14.04 is sufficient.
  - Install Sandstorm: `curl https://install.sandstorm.io | bash`
    - You will use this local Sandstorm server for development, so make sure it's running.
    - Make sure to make yourself a member of the server's group, usually called `sandstorm`.
      You may have to log out and back in before this takes effect.

## Framework-specific tools/guides

For some frameworks, we have special tools and/or guides to help you package apps more easily:

- [Meteor](https://meteor.com): Use [meteor-spk](https://github.com/sandstorm-io/meteor-spk).
- Python: See [Python](raw-python.md).
- Ruby on Rails: See [Ruby on Rails](raw-ruby-on-rails.md).
- Pure-client/browser-side: (e.g. [Unhosted](https://unhosted.org)-style) See [Pure client apps](raw-pure-client-apps.md).
- (more soon)

Even if your framework is listed above, you should still read everything on this page as well in order to better understand Sandstorm.

## Generic steps

### Write an app

You can write your app on absolutely any tech stack that runs on Linux. Write a web app the way you normally would. Make sure it stores all data under `/var`, because the rest of the filesystem will be read-only when running in Sandstorm.

For the sake of this tutorial, we'll use this simple [Node.js](http://nodejs.org) app, which will call `main.js`:

    var http = require('http');
    http.createServer(function (req, res) {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('Hello World\n');
    }).listen(10000, '127.0.0.1');
    console.log('Server running at http://127.0.0.1:10000/');

Make sure you have Node installed, so that this app runs when you type:

    node main.js

### Create a Sandstorm package definition

In your app's source directory, type:

    spk init -p 10000 -- node main.js

This tells Sandstorm that the command to start your app is `node main.js` and that it can then connect to the HTTP interface on port 10000.

This command will write the file `sandstorm-pkgdef.capnp` capturing the new configuration. Feel free to open it up and see what has been written. You can adjust a lot of things here.

### Test your app in dev mode

Again in your package directory, type:

    spk dev

This command temporarily registers your app with your locally-installed Sandstorm server. If you browse to your server and look at your files menu, you'll now see that your app is available there and you can create a new instance. Do so, and make sure it works.

While in dev mode, make sure to test _all_ of the features of your app. Sandstorm is watching what your app does and is making a list of all of your app's runtime dependencies, so it can make a package out of them. If you don't test a feature in dev mode, it might not work in production.

Your app's console (debug) output can be viewed by clicking the console icon in the top bar.

If something is not working and your own debug logs aren't helping, you may also want to check the Sandstorm server's main logs in:

    /opt/sandstorm/var/log/sandstorm.log

When done testing, press `Ctrl+C` at your terminal to exit dev mode.

### Inspect the file list

The `spk` tool has created a text file called `sandstorm-files.list` listing all the files used by your app. Open it in a text editor and verify that it looks reasonable. You may in particular want to verify that it hasn't pulled in any personal files from your system, although the default configuration hides `/home` and `/var` which should stop most leaks. If any files look wrong, you should remove them from the list, and then edit `sandstorm-pkgdef.capnp` to list those files as "hidden" so that they don't get re-added to the list the next time you run in dev mode. You should probably also re-run `spk dev` and test your app again.

Pay particular attention to files taken from `/etc`. Unfortunately, many apps rely on configuration found it `/etc` for basic operation, but files in `/etc` are often fairly specific to your host system and thus may not belong in your app package. If you want to override a file from `/etc` that your app needs, simply create at `etc` directory in your source tree and put a different version of the file there. The default `sandstorm-pkgdef.capnp` maps `.` over `/`, so it will prefer `./etc/foo` over `/etc/foo` to satisfy a requirement for `etc/foo`.

### Build your package

Type:

    spk pack my-app.spk

This will build `my-app.spk` for distribution. You can upload this to any Sandstorm server by going to the `/install` URL.

### Publish your app

If you packaged a cool app to Sandstorm, [we want to know about it](https://groups.google.com/group/sandstorm-dev)!

You should check out the [app publishing guide](publishing-apps.md) for details on how to submit your app to the [App Market](https://apps.sandstorm.io).

## Tips and Tricks

### Accessing external resources

By default, your app does not have network access, even on the server side. It can only answer HTTP request from the user. If you need access to things in the outside world, you will have to request them through the Sandstorm APIs. Guides for accessing specific kinds of external resources -- including sending outgoing HTTP requests, sending and receiving e-mail, etc. -- can be found [in the full developer documentation](../developing.md).

### Reproducible builds

The approach described above of copying files directly off your development machine is great for getting up-and-running quickly, but not great for long-term maintenance. As your project gets more serious, you'll want to think about setting up a hermetic build environment that other developers can easily reproduce.

By editing `sandstorm-pkgdef.capnp`, you can tell Sandstorm not to look for files on your actual host system, but rather look in some other directory that you set up yourself. So, you could create a clean "chroot" environment inside a separate directory, then tell Sandstorm to look for files there. The details of how to set up chroot environments are beyond the scope of this document, but are already widely-understood and not specific to Sandstorm. [Try Googling it.](https://www.google.com/search?q=creating+a+chroot+environment)

### Testing updates

When you later make changes to your app, you can test it against existing data created with an older version. Whenever you run `spk dev`, the development version of the app will temporarily override any installed version, even when opening preexisting files.

### Keyrings

Your app package is cryptographically signed (using Ed25519, if you care). The public key acts as the application's global ID. All packages signed with the same key represent different releases of the same app.

When you ran `spk init`, Sandstorm created a new keypair for you. You can see your app's ID in `sandstorm-pkgdef.capnp`. The corresponding private key was placed on your Sandstorm keyring, which by default is stored at `$HOME/.sandstorm-keyring`. You need to keep this file safe! If you lose it, you won't be able to build updates of your app, and if someone steals it, they'll be able to publish updates for your app.

When running in dev mode (`spk dev`), the keyring is not actually needed. Since you're publishing on a local server over which you have complete control anyway, the server just trusts the ID you give it. This means that you need not distribute your private key to every developer working on your app. Only the person building releases needs to have the key.

Keyrings can be merged by concatenating them (with plain old `cat`). To pull specific keys out of your keyring to send to people, use the `spk getkey` command (type `spk help getkey` for usage information).

Currently, keyrings are not encrypted, which means they are vulnerable to any software running under your user account. This is probably bad and will be improved eventually, though in general if you have malware running as yourself then you're pretty screwed already.

### Package IDs

You can get your data-package-id by running the following command:

    sha256sum package.spk | head -c 32; echo

This is no longer particularly important info now that the app market has launched, and this is handled automatically.

### What makes a good Sandstorm app?

Not every web app makes sense as a Sandstorm app. Sandstorm is specifically intended for apps that store data which is logically owned by users. Each instance of an app is owned by an individual end user -- _not_ the app's developer. The user may share their instance with other users and collaborate, but ultimately each instance belongs to an individual.

Things that make sense as Sandstorm apps:

- Document editors, spreadsheets, and similar content creation.
- E-mail/chat/communications.
- Calendars, to-do lists, personal task management.
- RSS readers.
- Personal file/media storage.
- Blogging apps (including microblogging).
- Personal profiles.
- Federated social networks.

Things that do not make sense as Sandstorm apps:

- Public search engines.
- News portals.
- Large discussion forums (although a federated forum where each user owns the threads they created could make sense).
- Content distribution services.
- Storefronts.
- Centralized social networks.

Users can create multiple instances of any app they install. Each instance is, by default, isolated from the others, and can be independently shared. Apps should strive to implement instances with a level of granularity that makes sharing make sense. For example, a document editor app should host every document in a separate instance, so that users can use the Sandstorm platform's sharing features to share access to their documents.
