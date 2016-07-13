This document covers **detailed technical documentation** on how to use `install.sh`.

## How to install Sandstorm

If you want to install Sandstorm now, you should probably read our [guide on how to install
Sandstorm](../install.md).

## Overview of the install process

The job of `install.sh` is to:

- Verify that this system has a Linux kernel version and CPU architecture compatible with Sandstorm,
  including verifying Linux kernel build-time options if needed.

- Download a binary copy of Sandstorm, also known as the [Sandstorm
  bundle](guide.md#sandstorm-itself), including verifying its signature.

- Create a directory to unpack that bundle, and unpack it there.

- If desired, request free dynamic DNS and/or HTTPS certificates from the Sandstorm company's own
  [sandcats.io](sandcats.md) service.

- Create a Sandstorm configuration file embodying the user's preferences on how this Sandstorm
  server should be configured, including enabling automatic updates if desired.

- If the user wants Sandstorm to start at boot, then also start Sandstorm as part of the install
  script.

- Ensure the user is able to configure login and other essential details on their Sandstorm server
  via a web interface, which includes the task of creating an [admin
  token](faq.md#how-do-i-log-in-if-there-s-a-problem-with-logging-in-via-the-web).

The install script can perform some other related tasks, but these are the core goals.

## Integrating with configuration management systems like Ansible/Puppet

If you want to prepare a server to run Sandstorm using a configuration management system, the
configuration management system should take the following steps.

- Download install.sh at runtime within the configuration mangement system from
  [https://install.sandstorm.io/](https://install.sandstorm.io/), and [verify the install.sh
  signature](../install.md#option-3-pgp-verified-install).  Alternatively you can download
  install.sh into your own trusted file storage area and verify it as part of copying it to your own
  trusted file storage area.

- Run install.sh with the options of your liking, per this document's [Non-interactive
  installation](#non-interactive-installation) section.

- If you need to make further configuration changes, then stop the Sandstorm service with `sudo
  service sandstorm stop`, modify the config file in `/opt/sandstorm/sandstorm.conf` so that it
  contains the contents you want, and start the Sandstorm service.

Note that `BASE_URL`, `WILDCARD_HOST`, and `ALLOW_DEV_ACCOUNTS` are three configuration file options
whose value you will want to verify. See the [full documentation on sandstorm.conf](config-file.md).

This process uses install.sh to download the Sandstorm binary bundle. Another option would
hypothetically be an APT repository. However, at the time of writing (July 2016), there is no APT
repository for Sandstorm because we have not yet examined fully how to retain Sandstorm's
self-containerization and auto-updates in conjunction with an APT repository.

You can look at these examples as a starting-point:

- [Sandcastle](https://github.com/iflowfor8hours/sandcastle), an Ansible playbook that installs
  Sandstorm as part of "An opinionated configuration for running sandstorm with a focus on security
  and paranoid assumptions."

- [Sandstorm's installer test suite](#examples) includes some automated invocations of install.sh.

## Non-interactive installation

### Command-line flag to skip interactive prompts

If you run `install.sh -h`, you will see a message like:

```
usage: ./install.sh [-d] [-e] [-u] [<bundle>]
If <bundle> is provided, it must be the name of a Sandstorm bundle file,
like 'sandstorm-123.tar.xz', which will be installed. Otherwise, the script
downloads a bundle from the internet via HTTP.

If -d is specified, the auto-installs with defaults suitable for app development.
If -e is specified, default to listening on an external interface, not merely loopback.
If -i is specified, default to (i)nsecure mode where we do not request a HTTPS certificate.
If -u is specified, default to avoiding root priviliges. Note that the dev tools only work if the server as root privileges.
```

The `-d` option will use **defaults** for all options, creating a fully non-interactive install.  If
you provide that option by itself, you will get a `sandstorm.conf` configured to use:

- `BASE_URL=http://local.sandstorm.io:6080`
- `BIND_IP=127.0.0.1` (or `BIND_IP=0.0.0.0` if you pass `-e`)

and other defaults. One way to get a fully-automated install is to use `-d`, accept all defaults,
and stop Sandstorm, modify `/opt/sandstorm/sandstorm.conf` to your liking, and then start Sandstorm.

Another way is to request specific custom behavior from `install.sh`.

### Environment variables to request custom behavior

Over the time we have spent maintaining the install script, we hae found it easier to provide
user-provided configuration options from environment variables, rather than command line flags. Here
are some environment variables that `install.sh` can look for, and their meanings.

- `OVERRIDE_SANDSTORM_DEFAULT_DIR`: If you specify this, Sandstorm will install into this
  directory rather than `/opt/sandstorm` by default.

- `OVERRIDE_SANDSTORM_DEFAULT_SERVER_USER`: If you specify this, Sandstorm will use this username
  rather than a user account called `sandstorm`. This maps into the Sandstorm configuration file as
  `SERVER_USER`.

**Sandcats-specific environment variables.** Some environment variables are specifically about
controlling the install script's interaction with the [sandcats.io](sandcats.md) dynamic DNS and
free HTTPS certificate service.

- `DESIRED_SANDCATS_NAME`: The name of the the sandcats.io subdomain you would like to use for this install.

- `SANDCATS_DOMAIN_RESERVATION_TOKEN`: A token that indicates you have pre-reserved a sandcats.io subdomain.

- `OVERRIDE_SANDCATS_GETCERTIFICATE`: If you specify this as `no`, then Sandstorm will not bother
  requesting a HTTPS certificate from sandcats.io. The install script will prompt you about sandcats
  to ask if you want to use it for dynamic DNS.

- `OVERRIDE_SANDCATS_BASE_DOMAIN`: If you run a different instance of the sandcats.io software,
  adjust this variable.

- `REPORT`: This controls if install.sh should ask you to report an installation error to us. Set
  it to a non-`yes` value (e.g. `no`) if you want to disable that question. Most headless installations
  would want to set `REPORT=no`.

### Examples

To pass an environment variable to the Sandstorm installer, you can do as follows.

```bash
curl https://install.sandstorm.io/ > install.sh
sudo OVERRIDE_SANDSTORM_DEFAULT_DIR=/opt/sandstorm-is-awesome bash install.sh -d
```

This will install Sandstorm to `/opt/sandstorm-is-awesome` instead of the default directory.

To see examples of further customized installs, look at these tests within the Sandstorm installer
test suite.

- [Installation with a domain reservation code for sandcats.io](https://github.com/sandstorm-io/sandstorm/blob/master/installer-tests/full-server-install-with-domain-reservation-token.t)

- [Headless fully-automated install](https://github.com/sandstorm-io/sandstorm/blob/master/installer-tests/automatic-dev-install-on-jessie.t)

### Support level

If you rely on these environment variables for driving the Sandstorm installer, then consider
emailing the [sandstorm-dev Google Group](https://groups.google.com/forum/#!forum/sandstorm-dev) to
make sure we understand your use-case.

In general, these are supported at a best-effort level. If we need to change something about how
these work, you will hear about it on the sandstorm-dev group.

### Automated test suite

The Sandstorm install script is covered by a (sometimes-flaky) automated test suite. You
can read more here:

- [README.md in installer-tests/](https://github.com/sandstorm-io/sandstorm/tree/master/installer-tests)
