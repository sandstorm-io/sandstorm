# sniproxy for sharing a TLS port 443 with Sandstorm

The purpose of this tutorial is to set up sniproxy so it’s possible to use regular https:// URLs for your main web server, like nginx or Apache, as well as Sandstorm, which has its own HTTPS handling. To make that work, they will need to share port 443.

## Introduction

The purpose of this tutorial is to set up *sniproxy* so it's possible to use Sandstorm-verified TLS encryption while coexisting with another web server that also uses TLS and share port 443 with it.

The main reason is to allow users to connect with your Sandstorm instance in the standard HTTPS port (443) and keep using that port also for any other web apps.

This action is going to change the BASE_URL of Sandstorm, presumably, so you'll trigger the erasing of OAuth configuration. To fix that, you will need to follow the "How do I log in, if there's a problem with logging in via the web?" section of [the FAQ](faq.md).

This document assumes the server is running Debian or one of its derivatives (e.g. Ubuntu). If your server is not, you might need to adjust some steps. Note that there will be some downtime in this process so you might want to do it when your server is not very busy.

## Install sniproxy

If you're lucky, the package *sniproxy* might be present on your GNU/Linux distro; otherwise, you'll have to install it yourself. Follow the instructions at [the sniproxy homepage](https://github.com/dlundquist/sniproxy) for your operating system and install it.

In this example, on Ubuntu 10.04, the instructions were:

```bash
# Install required packages
sudo apt-get install autotools-dev cdbs debhelper dh-autoreconf dpkg-dev gettext libev-dev libpcre3-dev libudns-dev pkg-config fakeroot git

# Clone sniproxy repo from Github
git clone https://github.com/dlundquist/sniproxy.git

# Compile and create the package
cd sniproxy
./autogen.sh && dpkg-buildpackage

# Install the package
sudo dpkg -i ../sniproxy_*_*.deb
```

## Setting it up

We'll be using *sniproxy* to listen on the standard HTTPS port (443) and allow it to decide where to send the request based on the hostname being requested. If it's a Sandstorm domain (ends in ```.sandcats.io```) it will forward the request to Sandstorm on port 6443. In any other case it'll forward the request to the web server you already had, which we will switch from listening on port 443 to port 7443.

The ports for Sandstorm and the web server are arbitrary; you can choose ones that work for you in case you have a collision with another service you're running. It should work as long as you're consistent in replacing the ports in the web server, Sandstorm and sniproxy configuration files.

## Setting up sniproxy

We'll set *sniproxy* to forward Sandstorm domains to the Sandstorm instance and to send any other request to the web server. We'll disable the HTTP proxy feature in *sniproxy* as there is no need for the HTTP requests to go through it.

### Configuration

You will need to edit the sniproxy configuration file by running something like:

```bash
sudo nano /etc/sniproxy.conf
```

/etc/sniproxy.conf contents:
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

We'll have to ensure sniproxy starts when the system is rebooted. For that we'll need to ensure it is enabled in ```/etc/default/sniproxy``` (```ENABLED=1```). I had to also run this command to make sure sniproxy would automatically start on boot up:

```bash
sudo update-rc.d sniproxy enable
```

## Setting up Sandstorm

Enabling TLS support on Sandstorm is out of the scope of this tutorial. If you don’t have it set up yet, head to [the HTTPS guide](ssl.md).

We need to change Sandstorm's configuration so that it listens on the port that sniproxy is forwarding the requests to (9687 in these examples). We make sure BASE_URL and WILDCARD_HOST use URLs on port 443. Since that is the standard port for HTTPS, we don't need :443 at the end. We also adjust the BIND_IP. We'll assume you have ```example.sandcats.io``` as your Sandstorm address in the configuration example; you can change the example to use a different domain if you need to.

```bash
sudo nano /opt/sandstorm/sandstorm.conf
```

Relevant contents of ```/opt/sandstorm/sandstorm.conf```:
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

You probably have to fix the Sandstorm administrator OAuth token. Run the following and follow the instructions that it prints out:

```bash
sudo sandstorm admin-token
```

Now you can test by trying to get to your Sandstorm instance. In a web browser, visit https://example.sandcats.io (replace "example" with your sandcats domain) to make sure Sandstorm works. Next, test any other HTTPS service you had before (something like https://service.yourdomain.com).

If you are having problems finishing this tutorial correctly, visit https://serverfault.com/ and ask your question there. Thanks for reading this tutorial!


