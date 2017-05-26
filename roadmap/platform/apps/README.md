# Apps

Apps are code -- not running instances of code (those are [grains](../grains)), just the code. In addition to executing, code needs to be distributed, updated, and verified.

Sandstorm apps are distributed as `.spk` package files. An SPK is basically an archive of the app's entire userspace filesystem, inluding all code, assets, libraries, and other dependencies.

## Package Signatures

Every package is signed using an Ed25519 key pair. The public key becomes the "app ID" (usually represented in a base32 encoding). Packages signed by the same key represent different versions of the same app.

## Package Metadata

The package's root directory contains a manifest file containing an encoded Cap'n Proto struct with metadata about the package. This includes:

- The app title and icon.
- The version (an integer, used to decide whether the package is an upgrade from other versions of the same app).
- The "marketing version", which is an arbitrary string meant for human consumption, like "1.3.6".
- Information about the sandstorm API version against which the package was developed, used to ensure backwards-compatibility when APIs change.
- A list of "actions" representing entry points into the application when creating a new grain. Usually, one of these actions is a generic "New Instance" action which the user can invoke with a button press while other actions take a capability as input and are invoked via the [powerbox](../powerbox) (in a "have object, want app" interaction).
- A PGP signature linking the app ID to a PGP key. Sandstorm will look up the key's fingerprint from [keybase.io](https://keybase.io) to discover the app author's identity.

### Market Metadata

The above metadata is necessary for basic functionality, but the manifest may also include extended metadata primarily intended for display in the app market, such as a description, screenshots, site link, etc.

## Installation

A user may install an app by:
- Uploading an SPK directly to their server.
- Clicking on an "install" link from the app store or another site, which links back to the server specifyin a package hash and a download URL.

Installing an app merely means that:
- The package has been downloaded to the Sandstorm server (this only happens once per package per server; all users share the package).
- The user is offered the ability to create new instances of the app.

### Updates

When a user installs a package with the same app ID as some already-installed app, but with a newer version number, the user's grains are updated to the new version. This merely changes the package ID associated with each grain and then restarts any running grains, so that now they start up with the new package. It is up to the app to detect if any migrations are needed.

Sandstorm will automatically check the app market daily to see if it has newer versions available of any locally-installed apps. If so, it will download and install the new version, and update grains. To avoid interruptions, currently-running grains will not be updated until they next restart or until the owner explicitly requests an update.

Once a grain has started up using a new version of a package, it cannot be downgraded to old versions, because apps are not expected to support reverse migration (even if we told them to, they probably wouldn't test it).

TODO(feature): Users who do not want automatic updates can "pin" apps (or specific grains) to a specific app version. This is generally only needed by advanced users and developers, so is not a prominent option. Advanced users should also be given the option to force-downgrade, with a warning that it could damage the data.

TODO(feature): Organization administrators should similarly be able to pin app versions across an organization, so that they can validate updates before applying them.

TODO(feature): Before an app update, Sandstorm should snapshot a grain, and then allow the user to roll back in case things are broken. This would roll back the whole storage, so the user would lose any changes they had made.

_TODO(bug): Currently, when an app update is downloaded automatically, the user only receives a notification that an update is available, and must click to confirm that they want the update before it is applied. This arguably empowers the user, but is problematic for the server: a user who never logs in will never accept updates and thus the server will never be able to delete the package versions that they are using. Thus over time, servers with many users will tend to be stuck storing every version of every app. We should instead apply updates automatically unless the user has explicitly pinned the app to an old version._

## TODO(feature): Add-ons

A package may be marked as being an "add-on" to another package, which means it extends that other package's functionality. Add-ons can be used to, say, add new themes to Ghost or new plugins to Wordpress, without having to copy these files into every grain's mutable storage.

Technically speaking, an addon just extends the base package with additional files. The base package must indicate in its manifest that it supports add-ons and must indicate a directory where add-ons will be placed; each add-on becomes a subdirectory there, named according to its app ID.

Once a user installs an add-on, by default it should be added to all their existing grains and all new grains they create with the app (similar to installing a new version of an app). However, the user should be able to disable specific addons for a specific grain as an advanced option.
