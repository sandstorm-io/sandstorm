# Installation and removal

There are many options for installing Sandstorm with various trade-offs. Choose the one that is most
comfortable for you. This document also covers [uninstallation](#uninstall).  If you want to perform
unattended installation of Sandstorm, or learn how the install script works, read the [reference
documentation on the Sandstorm install script.](administering/install-script.md)

Sandstorm requires Linux x86_64, with kernel version 3.13 or later.

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
* `libcap` with headers
* `xz`
* `zip`
* `unzip`
* `strace`
* `curl`
* discount (markdown parser)
* [Clang compiler](http://clang.llvm.org/) version 3.4 or better
* [Meteor](http://meteor.com)

On Debian or Ubuntu, you should be able to get all these with:

    sudo apt-get install build-essential libcap-dev xz-utils zip \
        unzip strace curl clang-3.4 discount git
    curl https://install.meteor.com/ | sh

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
whole bundle for every change. Just do:

    cd shell
    sudo service sandstorm stop-fe
    ./run-dev.sh

Now connect to your local server like you normally would.

Later, when you are done hacking, you may want to restart the installed front-end:

    sudo service sandstorm start-fe

### Hacking on the C++

If you're going to edit C++, you will want to install [Ekam](https://github.com/sandstorm-io/ekam), the build system used by Sandstorm. Be sure to read [how Ekam works](https://github.com/sandstorm-io/ekam).

Once `ekam` is in your path, you can use `make continuous` in order to start an Ekam continuous build of Sandstorm. While this build is running, you can also run other `make` commands in a separate window. This will automatically synchronize with your continuous build rather than starting a second build.

To do a debug build, run make like:

    make continuous CXXFLAGS="-g"

If you suspect you'll be hacking on Sandstorm's dependencies as well, you may want to follow the dependency symlink trick described in the Ekam readme.

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

# Uninstall

If you installed Sandstorm with default options, the following actions will fully remove
Sandstorm. If you customized the install, you'll need to change these commands accordingly.

If you want to _change settings_, you can edit `/opt/sandstorm/sandstorm.conf`.

- Stop the service.

```bash
sudo sandstorm stop
sudo service sandstorm stop
```

- Remove the service file(s).

For systemd:

```bash
sudo systemctl disable sandstorm.service
sudo rm -f /etc/systemd/system/sandstorm.service
sudo systemctl daemon-reload
```

For sysvinit:

```bash
sudo update-rc.d sandstorm remove
sudo rm -f /etc/init.d/sandstorm
```

- Remove the two symlinks Sandstorm creates.

```bash
sudo rm -f /usr/local/bin/spk
sudo rm -f /usr/local/bin/sandstorm
```

- Edit `/etc/sysctl.conf` to remove any changes, and remove any `/etc/sysctl.d/50-sandstorm.conf`
  file if present . `install.sh` can optionally customize that file. It will leave behind a comment
  indicating that it did so, if it did so.

```bash
sudo rm -f /etc/sysctl.d/50-sandstorm.conf
sudo nano /etc/sysctl.conf
```

- Remove the sandstorm user ID and group ID.

```bash
sudo groupdel sandstorm
sudo userdel sandstorm

```
- Finally, remove Sandstorm and all its files.

```bash
sudo rm -rf /opt/sandstorm
```

Thanks for using Sandstorm!
