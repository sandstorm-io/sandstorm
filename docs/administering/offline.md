This document explains how to run a Sandstorm server that has no access to the internet ("airgapped" or "offline"). Please note that running such a server requires a bit of work, but it can be done.

## Prerequisites

Before you can run Sandstorm offline, your offline network will need to have a few other things:

1. A DNS server, with a [wildcard DNS entry](wildcard.md) pointing to your Sandstorm server. It is NOT sufficient to edit `/etc/hosts` on your client machines, since you cannot define wildcard entries in this file, although configuring dnsmasq on each client has been reported to work.
2. An LDAP server or SAML identity provider used to authenticate your users. For example, you could use [Active Directory Federation Services on Windows Server](active-directory.md#windows-server-active-directory), or OpenLDAP on Linux.

How to set up these services is not covered in this document.

## Installing Sandstorm Offline

By default, Sandstorm's install script downloads the latest release from `sandstorm.io`, but the script can also accept a release tarball as a parameter. To use it offline, you will need to obtain the installer script and a release tarball from the internet and transfer them to your server.

You can find and download the latest release by going to: [https://dl.sandstorm.io/](https://dl.sandstorm.io/) Look for the files titled `sandstorm-<version>.tar.gz` and find the one with the highest number for `<version>`. Download this file.

You can obtain the latest version of the installer script from our GitHub repository: [install.sh](https://raw.githubusercontent.com/sandstorm-io/sandstorm/master/install.sh) Transfer this file to your server as well.

Now, on your server, you can run:

    bash install.sh sandstorm-<version>.tar.gz

(Replace `<version>` with the version number you downloaded.)

Follow the on-screen instructions to set up your server. Note that:

- You cannot use the Sandcats DNS service. You must configure your own DNS. Remember that [Sandstorm requires a wildcard DNS entry](wildcard.md).
- You must use LDAP or SAML login to integrate with your network's single sign-on. Google, Github, and (probably) e-mail login will not work since they require internet access.
- When you reach the step in the installer where Sandstorm wants to pre-install some apps, choose "Skip for now", since Sandstorm won't be able to reach the app server.

## Updating Offline

Normally, Sandstorm automatically updates itself. Of course, it cannot do this if it does not have access to the internet. You should disable automatic updates by editing `/opt/sandstorm/sandstorm.conf`. Find the line for `UPDATE_CHANNEL` and change it to:

    UPDATE_CHANNEL=none

Then restart Sandstorm:

    sudo sandstorm stop
    sudo sandstorm start

Now, to update Sandstorm manually, obtain the latest release tarball from `dl.sandstorm.io` the same as you did to install it originally. Upload this to your server.

Then, run:

    sudo sandstorm update sandstorm-<version>.tar.gz

## Installing Apps

To install an app, you must manually obtain the app's SPK package file, then upload it to your server through Sandstorm's web interface. To obtain an SPK package from the app market, [visit the market](https://apps.sandstorm.io), find the app you want, and click the "Download SPK" button in the upper-right of the app's page. This will download the SPK file.

Unfortunately, the file will download with a name that is a long string of letters and numbers and does not end with `.spk`. You will need to rename the file to end with `.spk` before you can upload it to Sandstorm.

Once you have the SPK file and have renamed it, browse to your Sandstorm server, go to "Apps" in the left sidebar, and click the "Upload app..." button in the upper-right corner. Choose your SPK file.

Note Sandstorm is designed such that every user has an independent workspace and can upload their own apps. Every user will need to upload their own copy of the SPK for each app they wish to use. If you'd rather manage applications and updates centrally, you will need to run an offline app index (described below).

## Updating Apps

Normally, Sandstorm automatically checks sandstorm.io's servers for app updates, notifies you when an update is available, and lets you install the update with one click. Without internet access, it won't be able to do so.

To update an app that you've already installed, download the latest version of the SPK and upload it exactly the same as you did when you first installed it. Sandstorm will recognize that the new SPK is an upgrade and will prompt you to upgrade the app.

## Running an offline App Market and Index

If you wish to mark certain applications as pre-installed for all users, or want to allow users to receive notifications when an app update is available, you will need to provide your own offline mirror of the Sandstorm App Index.

In the admin settings, under "App sources", you can configure a custom URL to use for the "App Market" and the "App Index".

The **App Market** is a user interface (web page) where users can browse available apps and choose apps to install. Normally, this is at [apps.sandstorm.io](https://apps.sandstorm.io). This is where users are sent when they click the "Install..." button on the Apps list in Sandstorm.

The **App Index** is a server which provides app package downloads and an API to read app metadata. The App Market user interface obtains its data from the App Index. Additionally, Sandstorm servers directly query the App Index in order to discover and automatically download app updates. Normally, the app index is located at `app-index.sandstorm.io`.

### The App Index

The "App Index" is a web endpoint that serves app package downloads and metadata about them. Sandstorm pings the app index daily to check for app updates. Sandstorm's official app index is generated by our app review pipeline, which is open source, but probably does not make sense for you to run yourself.

Instead, you can set up an app index by running a static web server and hosting a set of files. The required files are:

* `/apps/index.json`: Metadata blob describing all apps. For example, here is [the official index.json](https://app-index.sandstorm.io/apps/index.json).

    The structure of this JSON is defined in the source code by [schema type `AppIndexForMarket` in app-index.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/app-index/app-index.capnp#L55).

    For the purpose of auto-updates, only `appId`, `packageId`, and `versionNumber` really need to be filled in. The other metadata is normally consumed by the App Market front-end.

* `/apps/<app-id>.json`: Extended metadata about each app. These files aren't queried for auto-update purposes, only by the app market front-end. For example, see [Wekan's app metadata](https://app-index.sandstorm.io/apps/m86q05rdvj14yvn78ghaxynqz7u2svw6rnttptxx49g1785cdv1h.json).

* `/packages/<package-id>`: SPK package files. `<package-id>` is the first half of the sha256 of the package, i.e. what you get from `sha256sum package.spk | head -c 32`. Note that the filenames don't have the `.spk` extension here. For example, here is [version 0.16.0~2017-03-21 of Wekan](https://app-index.sandstorm.io/packages/5a4a7ae7adbcc0876bdab2b0216d6152).

* `/images/<image-id>`: Images, e.g. icons, for consumption by the app market front-end. Not used for auto-updates. For example, here is [Wekan's icon](https://app-index.sandstorm.io/images/9512e76b225d6aad70dadc2227e2b06f.svg).

If you want to clone the entire Sandstorm app index, you could set up a cron job which copies all of the files periodically. You will need to discover what files to copy by starting from `index.json` and lookit at all the `appId` and `packageId` fields, mapping them to the respective `/apps/<app-id>.json` and `/packages/<package-id>` URLs, and downloading those. (If you plan to run an app market, you will need to crawl images as well.)

### The App Market

The "app market" is the web UI that users see when they click "install app".

If you have a full App Index set up (see above), you can run your own copy of Sandstorm's official App Market, the code for which can be found here: https://github.com/sandstorm-io/sandstorm-app-market

Alternatively, you could set up a simple static web page. The "install" button for each app should link the user to:

    https://<sandstorm-host>/install/<package-id>?url=https://<app-index-host>/packages/<package-id>

For an example of a simple web page implementing an app market, see [Sandstorm's very old app list](https://sandstorm.io/apps/index) (WARNING: this page is extremely outdated, but it still works as an example).

## Please Contribute Scripts

If you develop scripts to help run Sandstorm offline -- especially an offline app index or app market -- consider making your work open source! We'd love to link to them here.
