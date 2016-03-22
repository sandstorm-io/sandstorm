This document helps you configure Sandstorm to share port 80 (HTTP) with other services on the same
machine, or port 443 (HTTPS) with other services. It allows you to use a custom domain name, without
an ugly port number such as `:6080` in your URLs, and optionally with HTTPS.

If you use this document to set up HTTPS, note that you are in charge of obtaining and renewing your
HTTPS certificates.  This tutorial works properly with certificates you purchase, or with
[self-signed SSL.](self-signed.md) If you want [**free, auto-renewing sandcats.io HTTPS
certificates**,](ssl.md) you will need to use `sniproxy` instead of `nginx`; see the [note at the
bottom of the HTTPS overview page](ssl.md).

## Configuring nginx and Sandstorm for reverse proxying

### HTTPS or not: you choose

When running Sandstorm behind a reverse proxy such as nginx, you can configure HTTPS in the reverse
proxy.

This tutorial provides links to sample configuration files where relevant. The example files
configure nginx to listen on ports 80 (HTTP) and 443 (HTTPS). On port 443, nginx routes the traffic
to Sandstorm; on port 80, nginx serves a HTTP redirect to upgrade the request to HTTPS.

If you prefer to not use HTTPS, there are comments in the example coniguration file that indicates
what changes to make.

### Prerequisites for HTTPS

Create DNS entries for `example.com` and `*.example.com`.

Obtain or generate a key and TLS certificate with `example.com` and `*.example.com` in
subjectAltName. You can do that by [buying a wildcard HTTPS
certificate](https://google.com/search?q=cheap+wildcard+ssl) or by following our [self-signed
certificate authority instructions.](self-signed.md)

### Configure nginx

Install `nginx` with your package manager.

Copy [nginx-example.conf](https://github.com/sandstorm-io/sandstorm/blob/master/docs/administering/sample-config/nginx-example.conf) to `/etc/nginx/sites-enabled/`.

`nginx-example.conf` may be renamed to anything, such as `example.com.conf`. You'll need to make the following changes.

- All `server_name` lines should match the DNS hostnames for your Sandstorm install.

- Point `ssl_certificate` and `ssl_certificate_key` to your corresponding TLS certificate and key files.

Test your nginx configuration:

`sudo nginx -t`

### Configure Sandstorm's configuration files

First, **configure Sandstorm to listen on localhost, port 6080, for HTTP requests.** To do that, you
will need to edit `/opt/sandstorm/sandstorm.conf`. Make sure `HTTPS_PORT=...` line is **not** set,
as Sandstorm's HTTPS is designed for users of [sandcats.io free SSL](sandcats.md). Your `PORT`
and `BIND_IP` settings should look like this.

```
PORT=6080
BIND_IP=127.0.0.1
```

Then, **configure Sandstorm to use your new base URL and wildcard host.** To do that, edit
`/opt/sandstorm/sandstorm.conf` and adjust those settings. Here is an example for a Sandstorm server
that would be accessed by visiting `example.com` over HTTPS.

```
BASE_URL=https://example.com
WILDCARD_HOST=*.example.com
```

If you need a custom port number, you should place it in both `WILDCARD_HOST` and `BASE_URL`.

### Run

Finally, start nginx, and restart Sandstorm to use the new config.

```bash
sudo service nginx restart
sudo service sandstorm restart
```

### Reconfigure login within Sandstorm, if necessary

Make sure to test your Sandstorm install by visiting it on the web. If this operation
probably your `BASE_URL`, and if you are using OAuth providers for login, then this
change will disable them. Make sure to visit **Admin Settings** within your Sandstorm
install and re-enable them.

If OAuth providers were your only way to log in, you might need to get a login token via the command
line. See the answer in the [frequently-asked questions
page.](faq.md#how-do-i-log-in-if-theres-a-problem-with-logging-in-via-the-web)