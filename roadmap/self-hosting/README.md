# Self-hosting

This section describes features we'll build specifically to improve Sandstorm's self-hosting experience, including making it easier to install and manage as well as features that only make sense for self-hosters.

## Install Flow

_TODO(feature): Below describes an install flow where configuration is done in a web page, resulting in the generation of a custom installer script which takes no input. However, in practice what we have today is a single installer script for everyone which interactively prompts the user._

The installation process for Sandstorm begins on the web, and is an interactive process which eventually ends up with the user having a working Sandstorm account, either on their own server or on Sandstorm Oasis (our managed hosting). A new user should be able to go through the install flow without consulting any outside documentation; anything they need to know should be communicated as part of the flow.

Users may be directed to install Sandstorm from a variety of sources:
- From the Sandstorm front page or other Sandstorm advertisement.
- From an app page in the app store. In this case the user is interested in a specific app, and our install flow will keep track of this so that they can be prompted to install that app once Sandstorm is ready.
- From the developer documentation, in which case the flow should direct the user to set up a localhost server in dev mode accessed via `local.sandstorm.io`. (In this case we skip suggesting managed hosting or sandcats.io, as they are inappropriate for development.)

The first step of the install flow is to ask whether the user would prefer self-hosting or managed hosting. If they choose managed, they are directed to the [managed hosting](../managed-hosting) signup process.

If the user chooses self-hosting, they are then asked whether they'd prefer manual setup or sandcats.io, with a brief explanation of what's involved in manual setup. If they choose sandcats.io, we walk them through setting up an account (or signing in with their existing one). If they choose manual install, we prompt them for various information needed for manual setup, such as what their hostname will be, and we try to verify that these settings seem to work (e.g. doing DNS lookup).

At the end of the process, we offer the user a single command to run on their machine, along the lines of:

    curl https://install.sandstorm.io/4A0mmug66Zv4v2weP9DOLdlpKgw | bash

This runs an installer script customized for the user.

The installer script's responsibilities include:
- Verify that the host machine meets Sandstorm's requirements, such as kernel version and features.
- Check for evidence that Sandstorm has already been installed. If so, consult the user, giving them the option to install in a different location or update the existing install.
- Create a user account for Sandstorm (except for dev-mode installs, which should install under the user's own account).
- Download and install Sandstorm itself.
- Arrange for Sandstorm to start at boot.
- Create the `sandstorm` command symlink.

For non-dev-mode installs, also:
- Generate an SSL key for Sandstorm.
- Check for nginx or Apache running on the machine and, if present, assist the user in configuring them to map Sandstorm to the appropriate hosts. If not installed, try to assist the user in installing them.

For dev-mode installs:
- Create the `spk` command symlink.

Post-install, configuration options can be modified by the administrator within the web UI. A couple options, however, are necessary for the admin to get to the web UI in the first place, and therefore must be located in a config file:
- The URL of the main Sandstorm UI. (`BASE_URL`) Changing this also resets the OAuth configuration, since OAuth identity providers require that you specify the callback URL when creating the client key.
- The IP address and port to which the server binds. (`BIND_IP` and `PORT`)

### Integrity

The install script is PGP signed using Sandstorm's release keys, which can be verified through web-of-trust. The user must manually verify the installer script against the signature if they desire this verification. Instructions can be found in the docs.

The install script itself invokes GPG to verify a PGP signature on the downloaded bundle.

## Updater

Sandstorm automatically updates itself (unless the user opted out at install time).

### TODO(feature): Channels

_(As of February 2017, there is only one channel: dev)_

Following Chrome's lead, the user may choose an update "channel":

- `canary`: Updates are automatically pushed nightly, using the latest commit that passed tests.
- `dev`: Updates are pushed frequently, but manually, from the development branch.
- `beta`: Updates come from the latest release branch.
- `stable`: Updates come from the latest release branch that has been marked stable.

Every update has a build number, and updates are only allowed to increase the number. The build number divided by 1000 (rounded down) is the "branch number" -- each time a new release branch is cut, the dev branch's build number is immediately increased to the next 1000. For humans, we often represent this number as `<branch number>.<build number % 1000>`, e.g. "0.60" for build 60 or "3.12" for build 3012. (Hopefully, we'll never have more than 1000 builds between releases!)

A new release branch starts out "beta" but is marked "stable" at such a point as we feel it has proven itself in the wild.

### Integrity

Updates are downloaded strictly over https and should additionally be signed with an Ed25519 key pair.

### TODO(feature): Updates with new requirements

Before accepting an update, the updater (from the old version) will invoke the Sandstorm binary in the update with the command `check-update`, which can check for problems that might prevent the update from proceeding. For example, if Sandstorm starts requiring a newer kernel version, `check-update` could check for this. If `check-update` fails, the updater will arrange to display a warning box to the server owner through the web interface explaining that the server is not receiving updates and what they can do about it.

### TODO(feature): Broken Updates

If, _after_ an update, Sandstorm detects that it is not starting up correctly, the updater should go into "emergency update mode", where it checks for a new update every few minutes rather than once an hour. When our servers detect a spike in emergency update requests, a Sandstorm team member should be paged.

## Sandcats.io

Many aspects of setting up Sandstorm simply cannot be automated in an installer script, because they require external services. To help with this, we will offer Sandcats.io, which provides the exact services that a self-hosted Sandstorm server needs. Sandcats.io is optional -- some users will prefer to set things up manually, in order to remain fully independent.

Sandcats offers:

- DNS: `username.sandcats.io` and `*.username.sandcats.io` will be mapped to the user's IP address. Sandstorm on the user's machine will periodically ping Sandcats.io to make sure DNS stays updated.
- TLS: Sandcats.io offers free TLS certificates to users. Sandstorm on the user's machine will generate a new key and obtain a new certificate every week, in order to automatically recover from key leakage (e.g. the next Heartbleed). Certificates are provided by Globalsign.
- TODO(feature): SMTP: Sandcats.io can act as an e-mail transport, so that people can have `username@sandcats.io` as well as `*@username.sandcats.io`, and can send outgoing e-mail from their server.
- TODO(feature): Identity: Sandcats.io can be an identity provider, as an alternative to Google or Github login. We will require 2-factor authentication for all accounts.

## TODO(project): Sandstorm Distro

We will develop a "Sandstorm distro" which can be installed free-standing onto a machine or VM, without a separate Linux distro.

In this distro, Sandstorm itself can be the init process. There is no need for most of the Linux platform. The whole system may even fit into "initrd", which would make it especially easy to net-boot and auto-update.

When running in distro mode, the entire distro (including kernel) should be auto-updated. On important kernel updates, `kexec()` or one of the open Ksplice replacements should be employed to minimize downtime. (If this isn't fast enough, reboots could also be delayed until there is no activity or until the admin instructs the machine to reboot via the web interface.)

The Sandstorm distro should support "secure boot" to combat malware.

### VM images and one-click deploys

Once we have a Sandstorm distro, we can offer a standard VM image to make it easy for people to deploy Sandstorm to a VM cluster. We can also add Sandstorm to one-click deploy lists on various IaaS services, e.g. the AWS marketplace, Digital Ocean, etc.
