# Developing on Sandstorm

Sandstorm can run any web app that can run on Linux so long as the
code and all the dependencies have been bundled into an SPK file.
Anyone can make a Sandstorm package (SPK), such as the author of a
program or someone wants to run the app on their own Sandstorm
server.

If you haven't yet, now is a good time to try the Sandstorm demo!
Work through the [guided tour](guided-tour.md).


## Creating an app package

* **Tutorial**: [Five minute packaging tutorial](vagrant-spk/packaging-tutorial.md)
* **Conceptual overview**: [App Developer Handbook](https://github.com/sandstorm-io/sandstorm/wiki/Sandstorm-App-Developer-Handbook)
* **Language support**: [Platform stacks for Meteor, Python, PHP](vagrant-spk/platform-stacks.md) | [Other](vagrant-spk/platform-stacks.md#diy-platform-stack)
* **Code & service dependencies**: [Code dependencies](vagrant-spk/code-dependencies.md) | [MySQL](vagrant-spk/services.md#mysql) | [Other databases & services](vagrant-spk/services.md#other-services)
* **vagrant-spk in depth**: [Installation](vagrant-spk/installation.md) | [Customizing & understanding vagrant-spk](vagrant-spk/customizing.md)

<!--

Not written yet:

* **File storage & URLs**:  [Filesystem layout & permissions](developing/filesystem-layout.md) | [Static resources like CSS/JS]() | [Syncing URLs between grain-frame & address bar]()

* **SPK files**: [Publishing to the app list](packaging/app-list.md) | [SPK file size](packaging/file-size.md)

* **Troubleshooting**: [Troubleshooting](vagrant-spk/troubleshooting.md)

-->

---

## Sandstorm for systems hackers

You might enjoy learning how Sandstorm is put together.

* **Technical summary**: [How Sandstorm works](overview.md)
* **Minimalist packaging**: [Raw SPK packaging guide](developing/raw-packaging-guide.md)

---

## Network access

By default, Sandstorm runs each app instance with no network
access. Read these documents to configure an app to get access to
services on the Internet or to each other.

* **Supported protocol**: [SMTP (email)](https://github.com/sandstorm-io/sandstorm/wiki/Using-Email-From-Your-Sandstorm-App)
* **Other protocols**: Work in progress.
* **Inter-app communication**: Work in progress.

---

## App sharing, publishing, & permission levels

Each app instance (aka "grain") is private by default to the user who
created it. Read these documents to learn how access control works.

* **Overview**: [Delegation is the Cornerstone of Civilization](https://blog.sandstorm.io/news/2015-05-05-delegation-is-the-cornerstone-of-civilization.html)
* **Login & permissions**: [User authentication & permissions](https://github.com/sandstorm-io/sandstorm/wiki/User-Authentication)
* **Making it world-accessible**: [Publishing to the user's domain](https://github.com/sandstorm-io/sandstorm/wiki/Publishing-to-the-user's-domain) <!-- | [API keys]() -->

---

## Further reference documentation

We call Sandstorm a _platform_ because it provides concepts,
capabilities, and APIs that apps can use. The documentation about
further concepts may be found on our [GitHub
wiki](http://github.com/sandstorm-io/sandstorm/wiki).
