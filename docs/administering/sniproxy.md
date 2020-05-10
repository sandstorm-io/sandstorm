# Sharing the HTTPS Port with sniproxy

The purpose of this tutorial is to set up sniproxy so it’s possible to use regular https:// URLs for your main web server, like nginx or Apache, as well as Sandstorm, which has its own HTTPS handling. To make that work, they will need to share port 443.

This document assumes the server is running Debian or one of its derivatives (e.g. Ubuntu). If your server is not, you might need to adjust some steps. Note that there will be some downtime in this process so you might want to do it when your server is not very busy.

We are also going to assume you are using the Sandcats DNS/HTTPS service in this example, however this will work with any Sandstorm-managed TLS setup, provided the pattern is distinct from your other web services on the server.

## Install sniproxy

It is likely the package `sniproxy` is present on your Linux distro and you can install it through your package manager. Otherwise, follow the instructions at [the sniproxy homepage](https://github.com/dlundquist/sniproxy) for your operating system to install it manually.

## Setting up sniproxy

We'll be using sniproxy to listen on the standard HTTPS port (443) and allow it to decide where to send the request based on the hostname being requested. If it's a Sandstorm domain (ends in `.sandcats.io`) it will forward the request to Sandstorm on port 6443. In any other case it'll forward the request to the web server you already had, which we will switch from listening on port 443 to port 7443.

The ports for Sandstorm and the web server are arbitrary; you can choose ones that work for you in case you have a collision with another service you're running. It should work as long as you're consistent in replacing the ports in the web server, Sandstorm and sniproxy configuration files. We'll also disable the HTTP proxy feature in sniproxy as there is no need for the HTTP requests to go through it.

### Configuration

You will need to edit the sniproxy configuration file by running something like:

```bash
sudo nano /etc/sniproxy.conf
```

Here is the example configuration for `/etc/sniproxy.conf`:

```
# sniproxy.conf
# Setup for sharing port 443 with Sandstorm

user daemon
pidfile /var/run/sniproxy.pid

error_log {
    syslog daemon
    priority notice
}

listen 443 {
    proto tls
    table https_hosts
    fallback 127.0.0.1:7443

    access_log {
        filename /var/log/sniproxy/https_access.log
        priority notice
    }
}

table https_hosts {
    .*\.sandcats\.io 127.0.0.1:6443
}
```

### Startup

We'll have to ensure sniproxy starts when the system is rebooted. For that we'll need to ensure it is enabled in ```/etc/default/sniproxy``` (```ENABLED=1```).

The command to instruct your machine to start sniproxy on boot depends on your distro, but it is likely systemd-based, upon which you can run:

```bash
sudo systemctl enable sniproxy
```

Otherwise, if you have a sysvinit-based distribution, you may need to run:

```bash
sudo update-rc.d sniproxy enable
```

## Setting up Sandstorm

Enabling TLS support on Sandstorm is out of the scope of this tutorial. If you don’t have it set up yet, head to [the HTTPS guide](ssl.md).

We need to change Sandstorm's configuration so that it listens on the port that sniproxy is forwarding the requests to (6443, in this example). We make sure BASE_URL and WILDCARD_HOST use URLs on port 443. Since that is the standard port for HTTPS, we don't need :443 at the end. We also adjust the BIND_IP. We'll assume you have `example.sandcats.io` as your Sandstorm address in the configuration example; you will replace this with your own Sandcats hostname.

```bash
sudo nano /opt/sandstorm/sandstorm.conf
```

Relevant contents of `/opt/sandstorm/sandstorm.conf`:

```
# Bind localhost to avoid anyone connecting directly to Sandstorm
BIND_IP=127.0.0.1
# No ports here, standard HTTPS (port 443)
BASE_URL=https://example.sandcats.io
WILDCARD_HOST=*.example.sandcats.io
# This is the port sniproxy will connect to
HTTPS_PORT=6443
```

## Setting up your current web server

This will depend on the server you have, typically Apache or nginx. Remember the accessible URLs will still use the standard HTTPS port; this change is only made to allow the sniproxy to sit in the middle.

If you are using nginx, you can change all the configuration files using ```sed``` to replace 443 with 7443. To do that, run this command:

```bash
sudo sed -ri 's/443/7443/g' /etc/nginx/sites-available/*
```

Keep in mind this might not work for you if you're using '443' anywhere in the configuration files that is not to refer the port.

## Final steps: put it to work

Now is the time to see if it worked. Shutdown your web server and Sandstorm and start them again. Start sniproxy as well.

For example, if you are using nginx, you can run:

```bash
sudo service nginx stop
sudo service sandstorm stop
sudo service sniproxy start
sudo service sandstorm start
sudo service nginx start
```

Now you can test by trying to get to your Sandstorm instance. In a web browser, visit https://example.sandcats.io (replace "example" with your sandcats domain) to make sure Sandstorm works. Next, test any other HTTPS service you had before (something like https://service.yourdomain.com).

If you have any issues, feel free to [open an issue on GitHub](https://github.com/sandstorm-io/sandstorm/issues/new) or post on the [mailing list](https://groups.google.com/forum/#!forum/sandstorm-dev).


