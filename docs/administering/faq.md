One way to use Sandstorm is to run the software on your own server --
we call that _self-hosting_. This page answers common questions from
self-hosters.

## How do I log in, if there's a problem with logging in via the web?

If logging into your Sandstorm server over the web isn't working, you
can reset your Sandstorm's login providers. Resetting login providers
will retain all existing accounts, including account metadata such as
who is an admin.

These instructions assume you've installed Sandstorm as root, which is
the default recommendation. If not, remove the `sudo` from the
instructions below.

* Use e.g. `ssh` to log into the server running Sandstorm.
* Run this command to deconfigure all existing OAuth-based login providers.

        sudo sandstorm reset-oauth

  On success, it will print:

      reset OAuth configuration

* Run this command to generate a token you can use to log in as an admin, for emergency administration.

        sudo sandstorm admin-token

  This will print a message such as:

      Generated new admin token.

      Please proceed to http://sandstorm.example.com/admin/19bc20df04838fdc03101d898be075cc02de66f2
      in order to access the admin settings page and configure your login system. This token will
      expire in 15 min, and if you take too long, you will have to regenerate a new token with
      `sandstorm admin-token`.

* Visit the link it printed out, which gives you emergency access to the server's admin panel.

* From there, configure the login providers of your choosing.

* Now, log in as yourself. If you log in as the first user that ever signed into this Sandstorm instance, then you will be an admin.

## Why does Sandstorm require a wildcard host?

See [Why Sandstorm needs a wildcard host](wildcard.md).

## Why can't I access Sandstorm from the Internet, even though the server is running?

If your `sandstorm.conf` looks like this:

```
SERVER_USER=sandstorm
PORT=6080
MONGO_PORT=6081
BIND_IP=127.0.0.1
BASE_URL=http://mydomain.com:6080
WILDCARD_HOST=*.mydomain.com:6080
MAIL_URL=
UPDATE_CHANNEL=dev
```

then you need to change the `BIND_IP` value to `0.0.0.0`.

(To be pedantic, this the unspecified IPv4 address. For IPv6
compatibility, you may want `::` instead. I haven't tested this yet.)

## What ports does Sandstorm need open?

If you have a strict firewall around the server running Sandstorm, or
you are at home and have to enable "port forwarding" on a home wifi
gateway, here is a list of the ports Sandstorm needs. This applies on
cloud providers like Amazon EC2, where the defaults allow no inbound
traffic.

_Default configuration_

* **TCP port 6080**
* **TCP port 30025**

_Optionally_

* **TCP port 443**
* **TCP port 80**

## What are the minimum hardware requirements?

* Architecture: **amd64** (aka x86_64)
* RAM: 1 GB
* Disk space: 5 GB
* Swap: Enabled, if possible

You can probably get away with less, but I wouldn't advise it.

Using a virtual machine from Amazon EC2, Google Compute Engine,
Linode, Digital Ocean, etc., is fine; just make sure you have a recent
Linux kernel. Ubuntu 14.04 is an easy and good choice of base
operating system.

## Sometimes I randomly see a lot of errors across the board, while other times the same functions work fine. What's going on?

Do you have enough RAM? Linux will start randomly killing processes
when it's low on RAM. Each grain you have open (or had open in the
last couple minutes) will probably consume 50MB-500MB of RAM,
depending on the app. We therefore recommend using a server with at
least 2GB. If you have less that that, see the next question.

## My virtual machine doesn't have that much RAM, what can I do?

It might help to set up swap space. The following commands will set up
a file on-disk to use as swap:

    dd if=/dev/zero of=/swap.img bs=1M count=1024
    mkswap /swap.img
    swapon /swap.img

    echo /swap.img swap swap defaults 0 0 >> /etc/fstab

## Why do you support only Google, GitHub, and passwordless email for login?

Using Google or Github for login results in top-notch security and
straightforward federated authentication with very little work. This
lets Sandstorm be focused on what it's good at. (We could add Twitter,
Facebook, etc. login as well, but we are worried about people
forgetting which one they used and ending up with multiple accounts.)

For email logins, we chose to avoid passwords entirely. Passwords have
a lot of problems. People choose bad passwords. People -- even smart
people -- are often fooled by well-crafted phishing attacks. And, of
course, people regularly forget their passwords. In order to deal with
these threats, we believe that any password-based login system for
Sandstorm must, at the very least, support two-factor authentication
and be backed by a human security team who can respond to
hijackings. There must also be an automated password reset mechanism
which must be well-designed and monitored to avoid
attacks. Unfortunately, we don't have these things yet. Moreover, we
don't believe that building a secure password login system is the best
way for Sandstorm to deliver something interesting to the ecosystem.

Another problem with password login is that it makes federation more
complicated. When you federate with your friend's server, how does it
authenticate you? Not by password, obviously. Perhaps by OpenID or
OAuth, but that is again a thing we would need to implement.

In short, we think these are the most secure options we can provide
right now.

A note about when and why we think security is important:

* For self-hosted Sandstorm servers, we want to provide a secure experience.

* For public Sandstorm servers supporting a large number of users, account security is essential.

* For a development instance only accessible to `localhost`, login security may not be particularly important. You can enable the [dev accounts](https://github.com/sandstorm-io/sandstorm/issues/150) feature to create accounts for testing apps.

Federated login enables tracking, and passwordless email login enables
anyone with temporary access to an email account to hijack an account.
One way to overcome these problems is by building GPG login so you can
create an account based on your public key. You can track progress on
that effort in [this
issue](https://github.com/sandstorm-io/sandstorm/issues/220).

## Why do I see an error when I try to launch an app, even when the Sandstorm interface works fine?

Sometimes Sandstorm seems to be working fine but can launch no apps.

If you see an error screen like this:

![Unable to resolve the server's DNS address, screenshot in Chromium](http://rose.makesad.us/~paulproteus/tmp/unable-to-resolve.png)

even when the app management interface seems to work fine:

![Skinny Sandstorm admin interface, showing your app instance](http://rose.makesad.us/~paulproteus/tmp/works-fine.png)

This typically relates to Sandstorm's need for [wildcard
DNS](wildcard.md). Sandstorm runs each app _session_ on a unique,
temporary subdomain. Here's what to check:

* **Make sure the `WILDCARD_HOST` has valid syntax.** In the Sandstorm config file (typically `/opt/sandstorm/sandstorm.conf`, look for the `WILDCARD_HOST` config item. Note that this should not have a protocol as part of it. A valid line might be:

```
WILDCARD_HOST=*.yourname.sandcats.io:6080
```

* **Make sure wildcard DNS works for your chosen domain**. See also [this issue in our repository](https://github.com/sandstorm-io/sandstorm/issues/114). If setting up wildcard DNS is a hassle for you, consider using our free [Sandcats dynamic DNS](Sandcats-dynamic-DNS) service for your `WILDCARD_HOST`.