# Installation and removal

There are many options for installing Sandstorm with various trade-offs. Choose the one that is most
comfortable for you. This document also covers [uninstallation](#uninstall).  If you want to perform
unattended installation of Sandstorm, or learn how the install script works, read the [reference
documentation on the Sandstorm install script.](administering/install-script.md)

Sandstorm requires Linux x86_64, with kernel version 3.10 or later.

This page documents a number of ways to install Sandstorm, specifically:

- [Most common: Downloading and executing our carefully-written install script, verified by HTTPS](#option-1-https-verified-install)
- [Downloading the shell script via GitHub](#option-2-github-verified-install)
- [Using PGP to verify the authenticity of the script](#option-3-pgp-verified-install)
- [Installing Sandstorm from source code](#option-4-installing-from-source)
- [Using Ansible, Puppet, or other configuration management tools](#option-5-integrating-with-configuration-management-systems-like-ansiblepuppet)
- [Using Docker to run Sandstorm, with Sandstorm managing automatic updates](#option-6-using-sandstorm-within-docker)
- [Running Sandstorm on Mac/Windows systems via Vagrant & VirtualBox](#option-7-use-vagrant-when-deploying-on-mac-or-windows)

## Option 1: HTTPS-verified install

The easiest way to install Sandstorm is by running:

```bash
curl https://install.sandstorm.io | bash
```

If you accept the defaults, this will:

- Create a directory, `/opt/sandstorm`, that contains Sandstorm and all data created within Sandstorm. Therefore, this is the most essential directory when performing [backups](administering/backups.md).
- Download (and verify) the current release of Sandstorm, place it into `/opt/sandstorm`, and enable auto-updates.
- Create two symbolic links in `/usr/local/bin` to add `spk` and `sandstorm` to your $PATH.
- Create a service (using `sysvinit` or `systemd`) to make Sandstorm start on system boot.
- Enable free HTTPS and dynamic DNS if you choose to use a [sandcats.io](administering/sandcats.md) subdomain, which we hope you do!
- Run a small process as root for containerization and binding to ports, and run the rest of Sandstorm as a non-root user.
- Listen on port 80 & 443 if available, otherwise a different port.

You can jump straight into the install by running:

```bash
curl https://install.sandstorm.io | bash
```
You can also read [technical documentation on how the install script
works](administering/install-script.md), including non-interactive modes, or learn [how to
administer Sandstorm](administering.md) once it is installed.

Once Sandstorm is installed, it will update itself and all Sandstorm apps, gaining new features and
security updates automatically. If you desire security updates of the underlying system, and are
using Debian or Ubuntu, you can use the unattended-upgrades package, which can even reboot the
system as needed. Consider following [this
tutorial.](https://blog.mafr.de/2015/02/26/ubuntu-unattended-upgrades/)

## Option 2: GitHub-verified install

If you are uncomfortable with `curl|bash`, another option is to [download install.sh from our GitHub repository](https://raw.githubusercontent.com/sandstorm-io/sandstorm/master/install.sh) and then run it:

```bash
wget https://raw.githubusercontent.com/sandstorm-io/sandstorm/master/install.sh
bash install.sh
```

This verifies that you're running our published installer script, even in the unlikely event that someone has compromised our download server or HTTPS certificate. The installer will verify signatures on all additional files it downloads.

## Option 3: PGP-verified install

If you'd rather not trust HTTPS at all, even from GitHub, another option is PGP-verified install.

1. If you aren't experienced with GPG already, let's do these instructions in a new empty workspace to avoid confusion. (If you know what you're doing, you can skip this.)

    <pre><code class="hljs bash">export GNUPGHOME=$(mktemp -d)</code></pre>

2. Download and import the Sandstorm releases keyring.

    <pre><code class="hljs bash">curl https://raw.githubusercontent.com/sandstorm-io/sandstorm/master/keys/release-keyring.gpg | \
        gpg --import</code></pre>

3. Obtain the PGP key fingerprint of a Sandstorm developer you trust. There are several ways to do this:
    * Web of trust (for PGP experts).
    * [Meet us in person](http://www.meetup.com/Sandstorm-SF-Bay-Area/) and ask for our business cards.
    * Use our Keybase profiles, for example: [Kenton Varda (kentonv)](https://keybase.io/kentonv), [Asheesh Laroia (asheesh)](https://keybase.io/asheesh), [Drew Fisher (zarvox)](https://keybase.io/zarvox)

4. Download that developer's corresponding release key certificate [from the Sandstorm github repo](https://github.com/sandstorm-io/sandstorm/tree/master/keys). For example, if you chose Kenton:

    <pre><code class="hljs bash">wget https://raw.githubusercontent.com/sandstorm-io/sandstorm/master/keys/release-certificate.kentonv.sig</code></pre>

5. Verify the certificate with GPG. For example:

    <pre><code class="hljs bash">gpg --decrypt release-certificate.kentonv.sig</code></pre>

    The output looks something like (emphasis added):

    <pre><code class="hljs nohighlight"><b>As of September 2015, Sandstorm releases are signed with the PGP key with
    fingerprint 160D 2D57 7518 B58D 94C9  800B 63F2 2749 9DA8 CCBD. This assertion
    will be updated monthly; do not trust this certificate after October 2015.</b>
    <span style="color: #888">gpg: Signature made Wed 23 Sep 2015 04:20:25 PM PDT using RSA key ID 440DDCF1
    gpg: Good signature from "Kenton Varda &lt;kentonv@keybase.io&gt;"
    gpg:                 aka "Kenton Varda &lt;temporal@gmail.com&gt;"
    gpg:                 aka "Kenton Varda &lt;kenton@sandstorm.io&gt;"
    gpg:                 aka "Kenton Varda &lt;kenton@kentonshouse.com&gt;"
    gpg: WARNING: This key is not certified with a trusted signature!
    gpg:          There is no indication that the signature belongs to the owner.</span>
    <b>Primary key fingerprint: 8802 23DF 25AA 25A9 433A  F0FB 4067 8458 440D DCF1</b></code></pre>

    Read the signed statement (top bolded part) and decide if it checks out, and make sure the fingerprint of the signer (bottom bolded part) matches the one you trust. Note that you can ignore GPG's warning that the signature isn't trusted because you're checking the fingerprint directly (an advanced user would instead have pre-arranged to trust the key and could thus ignore the fingerprint).

    If you have the Keybase tools installed, you can use this much-friendlier command instead:

    <pre><code class="hljs bash">keybase decrypt -S kentonv release-certificate.kentonv.sig</code></pre>

6. Download the installer script and its signature.

    <pre><code class="hljs bash">wget https://install.sandstorm.io/install.sh
    wget https://install.sandstorm.io/install.sh.sig</code></pre>

7. Verify the signature, making sure the signing key's fingerprint matches the one from the certificate.

    <pre><code class="hljs bash">gpg --verify install.sh.sig install.sh</code></pre>

8. Run the installer.

    <pre><code class="hljs bash">bash install.sh</code></pre>

(Aside: You may wonder why our "release certificates" are signed natural-language statements, rather than using PGP key signing. The answer is that PGP key signing, or at least the GPG interface, does not seem well-equipped to handle expiring signatures that must be refreshed monthly. We'd like to improve this; please let us know if you have ideas!)

## Option 4: Installing from Source

### Prerequisites

Please install the following:

* Linux x86_64, with kernel version 3.13 or later
* C and C++ standard libraries and headers
* GNU Make
* GNU diffutils
* `g++`
* `libcap` with headers
* `xz`
* `zip`
* `unzip`
* `which`
* `flex`
* `bison`
* `strace`
* `curl`
* `python`
* `zlib1g-dev`
* `golang-go`
* `cmake`
* `strace`
* discount (markdown parser)
* [Meteor](http://meteor.com) version 1.8.2

On Debian or Ubuntu, you should be able to get all these with:

    sudo apt-get install build-essential libcap-dev xz-utils zip \
        unzip strace curl discount git python zlib1g-dev \
        golang-go cmake strace flex bison locales
    curl https://install.meteor.com/?release=1.8.2 | sh

On Fedora 34 you should be able to get them with:

    sudo dnf install make libcap-devel libstdc++-devel libstdc++-static \
       glibc-headers glibc-static glibc-locale-source gcc-c++ xz zip \
       unzip strace curl discount git python zlib-devel zlib-static \
       golang cmake strace flex bison which diffutils
    curl https://install.meteor.com/?release=1.8.2 | sh

If you have trouble getting the build to work on your distro, we recommend trying in a virtual
machine running the latest stable Debian release. This is easy to set up using Vagrant, like:

    vagrant init debian/bullseye64
    vagrant up
    vagrant ssh

### Get the source code

Get the source code from the git repository:

    git clone https://github.com/sandstorm-io/sandstorm.git

### Building / installing the binaries

Build the Sandstorm bundle:

    cd sandstorm
    make

(Note: You should *not* use `-j`, as we only use make as a meta-build system. The major components will utilize all CPU cores.)

Install it:

    make install

This installs your locally-built bundle just as would get if you had installed using
`https://install.sandstorm.io`. You will be asked various configuration questions. If you intend
to hack on Sandstorm itself, you should choose to run the server to run under your local user
account (the default is to create a separate user called `sandstorm`).

If Sandstorm is already installed, you can update to your newly-built version like so:

    make update

Note that this only works if you installed Sandstorm to run at startup. Otherwise, you will
have to manually do:

    /path/to/sandstorm update sandstorm-0.tar.xz

### Hacking on the shell

You can run the shell (front-end) in dev mode so that you can modify it without rebuilding the
whole bundle for every change. From the root of the repository, just do:

    sandstorm dev-shell

Now connect to your local server like you normally would.

### Hacking on the C++

If you're going to edit C++, you will want to install [Ekam](https://github.com/sandstorm-io/ekam), the build system used by Sandstorm. Be sure to read [how Ekam works](https://github.com/sandstorm-io/ekam).

Once `ekam` is in your path, you can use `make continuous` in order to start an Ekam continuous build of Sandstorm. While this build is running, you can also run other `make` commands in a separate window. This will automatically synchronize with your continuous build rather than starting a second build.

To do a debug build, run make like:

    make continuous CXXFLAGS="-g"

If you suspect you'll be hacking on Sandstorm's dependencies as well, you may want to follow the dependency symlink trick described in the Ekam readme.

### Running the test suite

After making changes, it is a good idea to run the automated tests.  Instructions for doing so are in [tests/README.md](https://github.com/sandstorm-io/sandstorm/blob/master/tests/README.md).

## Option 5: Integrating with configuration management systems like Ansible/Puppet

Configuration mangement tools like Ansible, Puppet, and Chef allow a sysadmin to declaratively state
how the server should be configured. This allows sysadmins within an organization to collaborate
more effectively.

If you want to prepare a server to run Sandstorm using a configuration management system, the
configuration management system should take the following steps.

- Download install.sh at runtime within the configuration mangement system from
  [https://install.sandstorm.io/](https://install.sandstorm.io/), and [verify the install.sh
  signature](#option-3-pgp-verified-install).  Alternatively you can download
  install.sh into your own trusted file storage area and verify it as part of copying it to your own
  trusted file storage area.

- Run install.sh with the options of your liking. Examine the [install.sh reference
  documentation](administering/install-script.md) section for information about non-interactive use
  of install.sh.

- If you need to make further configuration changes, then stop the Sandstorm service with `sudo
  service sandstorm stop`, modify the config file in `/opt/sandstorm/sandstorm.conf` so that it
  contains the contents you want, and start the Sandstorm service.

Note that `BASE_URL`, `WILDCARD_HOST`, and `ALLOW_DEV_ACCOUNTS` are three configuration file options
whose value you will want to verify. See the [full documentation on
sandstorm.conf](administering/config-file.md).

You can look at these examples as a starting-point:

- [Sandcastle](https://github.com/iflowfor8hours/sandcastle), an Ansible playbook that installs
  Sandstorm as part of "An opinionated configuration for running sandstorm with a focus on security
  and paranoid assumptions."

- [Sandstorm's installer test suite](administering/install-script.md#examples), where you can find some automated
  invocations of install.sh.

Note that this process uses Sandstorm's install.sh to download Sandstorm. Another option would be if
Sandstorm provided an APT repository. However, at the time of writing (July 2016), there is no APT
repository for Sandstorm because we have not yet examined fully how to retain Sandstorm's
self-containerization and auto-updates in conjunction with an APT repository.

## Option 6: Using Sandstorm within Docker

Docker is a popular tool for declaring how to run code on servers. Sandstorm can run within Docker.
We recommend running Sandstorm outside of Docker because we mostly test Sandstorm outside of Docker
and our integration with Docker is somewhat non-idiomatic. If your organization runs all server
software within Docker, this is one way to make that work.

To run Sandstorm within Docker, run the following commands in a shell.

```bash
$ docker run --privileged -i -t -v sandstorm-data-volume:/opt/sandstorm --name sandstorm-build buildpack-deps bash -c 'useradd --system --user-group sandstorm ; curl https://install.sandstorm.io/ > install.sh && REPORT=no bash install.sh -d -e'
$ docker run --privileged -i -t --sig-proxy=true -p 0.0.0.0:6080:6080 -v sandstorm-data-volume:/opt/sandstorm buildpack-deps bash -c 'useradd --system --user-group sandstorm && /opt/sandstorm/sandstorm start && tail -f /opt/sandstorm/var/log/sandstorm.log & sleep infinity'
```

Sandstorm needs to start as root so it can do its own containerization of itself and of apps within
Sandstorm. We use `-i -t --sig-proxy=true` so that you can use Ctrl-C to stop the container on your
terminal.

The first command runs the Sandstorm installation script, saving its output to a Docker volume
called `sandstorm-data-volume`. You can choose a specific directory on your filesystem if you prefer
by replacing `sandstorm-data-volume` with `/path/to/specific/directory`. It configures the Sandstorm
install script to not attempt to report installation problems to us (`REPORT=no`), to use defaults
(`-d`), and to listen on all network interfaces (`-e`) including the Docker bridge interface.

The next command runs the Sandstorm bundle stored in the volume, serving forever. The `tail -f`
command is used to print out the Sandstorm log while Sandstorm runs. Sandstorm will be available at
http://local.sandstorm.io:6080/ . `local.sandstorm.io` is a DNS alias for localhost, indicating that
the service is running on the computer where you run Docker.

This process uses Sandstorm's install.sh to download Sandstorm, and Sandstorm is configured via
`sandstorm.conf` within the container. To configure and manage the container, note the following.

- Sandstorm manages its own automatic updates in the `/opt/sandstorm` directory, which is
  inconsistent with the typical Docker approach of using Docker images to manage updates and
  versioning for application code.

- The install script uses `local.sandstorm.io` and enables development accounts in the `-d` mode. To
  configure Sandstorm for production use, clear the Docker volume (or create a new one), then remove
  `-d` from the first `docker run` invocation so that the Sandstorm install script can ask you
  questions.

- Sandstorm depends on `curl`, `xz`, `openssl`, and `id` from the underlying container. We chose the
  `buildpack-deps` image because it contains those utilities and is maintained by the Docker
  team. We recommend periodically updating the `buildpack-deps` container for security reasons and
  stopping & starting Sandstorm on the new `buildpacks-deps` container.

- Sandstorm doesn't currently update its configuration when run under different environment
  variables; instead, one must edit the `sandstorm.conf` file within the data volume.

- Sandstorm is a single-machine program, and so you cannot safely run multiple instances of it
  behind a load balancer on multiple nodes at once. Sandstorm's database lives within the same
  container and its design currently assumes a single machine.

We're hopeful that the above approach is useful, although we know that it is not the most idiomatic
use of Docker.

## Option 7: Use Vagrant when deploying on Mac or Windows

If your organization's servers run Mac OS or Windows, you will need a virtualization tool to run
Sandstorm, since Sandstorm requires the Linux kernel.

One option is to use Vagrant and VirtualBox; the Sandstorm source repository contains a
"Vagrantfile" that creates a Linux virtual machine containing Sandstorm. Through the Vagrantfile,
your Linux virtual machine runs the latest version of Sandstorm, with automatic updates enabled; it
uses the same install script as described earlier in this document.

You must [install Vagrant](https://www.vagrantup.com/docs/installation/) and a virtualization software
package such as [VirtualBox](https://www.virtualbox.org/wiki/Downloads),. Both are available free of
cost.

To try this, you can perform the following steps:

```bash
$ git clone https://github.com/sandstorm-io/sandstorm
$ vagrant up
```

In this configuration, Vagrant/VirtualBox manage TCP port forwarding, and Sandstorm is available at
http://local.sandstorm.io:6080/ by default. `local.sandstorm.io` is a DNS alias for localhost,
indicating that the service is only visible on the computer where you ran Vagrant.

We do recommend that you run Sandstorm on a native Linux system, but we understand that this isn't
always an option. If you need further help making Sandstorm work with Vagrant or within
virtualization generally, please [open a GitHub issue](https://github.com/sandstorm-io/sandstorm/issues/new).

## Tips

* If installing Sandstorm under LXC / Docker, you will need to choose the option to install as a
  non-root user. Unfortunately, this means the development tools will not work. This is due to the
  interaction between Sandstorm and Docker's use of Linux containerization features and missing
  features in the Linux kernel which we hope will be fixed eventually. For non-development purposes,
  Sandstorm should run just fine under Docker.

* If you want to run on port 80, set `PORT=80` in your `sandstorm.conf` or look into a [reverse
  proxy](administering/reverse-proxy.md).

* If you want HTTPS/SSL, consider using our [free SSL certificate & dynamic DNS service](administering/ssl.md) or
  setting up a [reverse proxy](administering/reverse-proxy.md).

## Uninstall

To uninstall Sandstorm, run:

    sandstorm uninstall

This will remove all files installed by Sandstorm, but will not delete your user data. If you
wish to remove user data as well, do:

    sandstorm uninstall --delete-user-data

If you installed Sandstorm with default options, the following actions will fully remove
Sandstorm. If you customized the install, you'll need to change these commands accordingly.

If you want to _change settings_, you can edit `/opt/sandstorm/sandstorm.conf`.

Thanks for using Sandstorm!
