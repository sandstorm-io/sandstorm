This document helps you configure Sandstorm to share port 80 (HTTP) with other services on the same
machine, or port 443 (HTTPS) with other services. It allows you to use a custom domain name, without
an ugly port number such as `:6080` in your URLs, and optionally with HTTPS.

If you use this document to set up HTTPS, note that you are in charge of obtaining and renewing your
HTTPS certificates.  This tutorial works properly with certificates you purchase, or with
[self-signed SSL.](self-signed.md) If you want [**free, auto-renewing sandcats.io HTTPS
certificates**,](ssl.md) you will need to use `sniproxy` instead of `nginx`; see the [note at the
bottom of the HTTPS overview page](ssl.md).

If you have problems with apps seeming to constantly reload
themselves, you might need to [read about WebSocket connections in our
FAQ](faq.md#how-do-i-enable-websockets-proxying-or-why-do-some-apps-seem-to-crash-reload).

## Configuring nginx and Sandstorm for reverse proxying

### nginx optional: Apache2 and other choices available

This tutorial covers the use of nginx. If you prefer Apache2 or another reverse proxy, you can read
this document to get an overview.

For Apache2 in particular, feel free to use our
[sample VirtualHost configuration for Apache2](https://github.com/sandstorm-io/sandstorm/blob/master/docs/administering/sample-config/apache-virtualhost.conf)
Sandstorm requires WebSockets support; to enable that, make sure to pay attention to the
`RewriteRule` stanzas in the example configuration.

If you use a non-nginx, non-Apache2 reverse proxy, we'd love for you to
contribute a pull request with example configuration files.

### HTTPS or not: you choose

When running Sandstorm behind a reverse proxy such as nginx, you can configure HTTPS in the reverse
proxy.

This tutorial provides links to sample configuration files where relevant. The example files
configure nginx to listen on ports 80 (HTTP) and 443 (HTTPS). On port 443, nginx routes the traffic
to Sandstorm; on port 80, nginx serves a HTTP redirect to upgrade the request to HTTPS.

If you prefer to not use HTTPS, read the example configuration files and look for comments that
indicate what changes to make.

### Create DNS entries

If you are going to run Sandstorm at `example.com`, you may need to create a DNS record for
`example.com`. You will usually also need to add a wildcard DNS record for `*.example.com`. You can
read more about [wildcard DNS for Sandstorm.](wildcard.md)

### Prerequisites for HTTPS

Obtain or generate a key and TLS certificate with `example.com` and `*.example.com` in
subjectAltName. You can do that by [buying a wildcard HTTPS
certificate](https://google.com/search?q=cheap+wildcard+ssl), following our [self-signed certificate
authority instructions](self-signed.md), or using [CloudFlare Origin CA's free wildcard
certificates.](https://blog.cloudflare.com/cloudflare-ca-encryption-origin/)

If you are using nginx, place the following certificate data in the following paths on your system.

- **HTTPS private key** in `/etc/nginx/ssl/sandstorm.key`. This should be owned by root, permissions
  mode 0600. To set the permissions, you can run the following commands.

    - `sudo chown root.root /etc/nginx/ssl/sandstorm.key`
    - `sudo chmod 0600 /etc/nginx/ssl/sandstorm.key`

- **HTTPS certificate** in `/etc/nginx/ssl/sandstorm.crt`. With nginx, the certificate file should
  contain the full intermediate certificate chain. This should be owned by root or any other user,
  and the mode should be 0600 or any other permissions. To set the permissions, you can run the
  following commands.

    - `sudo chown root.root /etc/nginx/ssl/sandstorm.crt`
    - `sudo chmod 0600 /etc/nginx/ssl/sandstorm.crt`

### Configure nginx

Install `nginx` with your package manager.

Copy [nginx-example.conf](https://github.com/sandstorm-io/sandstorm/blob/master/docs/administering/sample-config/nginx-example.conf) to `/etc/nginx/sites-enabled/`.

`nginx-example.conf` may be renamed to anything, such as `example.com.conf`. You'll need to make the following changes.

- All `server_name` lines should match the DNS hostnames for your Sandstorm install.

- Point `ssl_certificate` and `ssl_certificate_key` to your corresponding TLS certificate and key files.

Test your nginx configuration:

`sudo nginx -t`

### Configure Sandstorm's configuration files

First, **configure Sandstorm to listen on localhost, port 6080, for HTTP requests.** We use port
6080 here to match the example nginx configuration. You will need to edit
`/opt/sandstorm/sandstorm.conf`. Make sure there is no `HTTPS_PORT=...` line, as the
`HTTPS_PORT=...` configuration option enables Sandstorm's [auto-renewing sandcats.io free
SSL](sandcats.md). The `PORT` and `BIND_IP` settings should look like this.

```
PORT=6080
BIND_IP=127.0.0.1
```

Then, **configure Sandstorm to use your new base URL and wildcard host.** Here is an example pair of
lines from `/opt/sandstorm/sandstorm.conf` for a Sandstorm server that would be accessed by visiting
`example.com` over HTTPS.

```
BASE_URL=https://example.com
WILDCARD_HOST=*.example.com
```

**If you are serving HTTPS or HTTP on non-default port numbers,** then you will need to add a port
number to both `WILDCARD_HOST` and `BASE_URL`.  In the example configuration, nginx listens for
HTTPS on port 443 and HTTP on port 80, which are the default ports, so you do not need add a port
number unless you are doing an unusual Sandstorm install.

### Run

Finally, start nginx, and restart Sandstorm to use the new config.

```bash
sudo service nginx restart
sudo service sandstorm restart
```

### Test your Sandstorm install

Make sure to test your Sandstorm install by visiting it on the web.

**Make sure login works.** If you changed your `BASE_URL`, Sandstorm will temporarily disable any
OAuth providers like Google or GitHub so that you can ensure they are configured correctly. Make
sure to visit **Identity providers** in the **Admin panel** within your Sandstorm install and re-enable them. If OAuth
providers were your only way to log in, you might need to get a [login token via the command
line.](faq.md#how-do-i-log-in-if-theres-a-problem-with-logging-in-via-the-web)

**Make sure grains can start.** Visit a grain, or create a new one, and ensure it loads properly. If
it does not, you might have an issue with [wildcard DNS or SSL.](wildcard.md)
