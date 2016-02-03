This document helps you configure Sandstorm to share port 80 (HTTP) with other services on the same
machine, or port 443 (HTTPS) with other services.

If you use this document to set up HTTPS, note that it results in nginx having your HTTPS private
key. If you want [**free, auto-renewing sandcats.io HTTPS certificates**,](ssl.md) you will need to
use `sniproxy` instead of `nginx`; see the [note at the bottom of the HTTPS overview page](ssl.md).
This tutorial works properly with certificates you purchase, or with [self-signed
SSL.](self-signed.md).

Through this process, you can remove the `:6080` of the URL if your Sandstorm is listening on port
6080.

## Configuring nginx and Sandstorm for reverse proxying

In this configuration, [nginx](http://nginx.org/en/) will listen on port 80 and redirect all
Sandstorm traffic to HTTPS (port 443).  nginx will also listen on port 443 and reverse-proxy to
Sandstorm on port 6080.

If you want to use just HTTP (port 80), read the comments in the example configuration file.

### Prerequisites

Create DNS entries for `example.com` and `*.example.com`.

Obtain or generate a key and TLS certificate with `example.com` and `*.example.com` in
subjectAltName. You can do that by [buying a wildcard HTTPS
certificate](https://google.com/search?q=cheap+wildcard+ssl) or by following our [self-signed
certificate authority instructions.](self-signed.md)

Install `nginx` with your package manager.

### Configure nginx

Copy [nginx-example.conf](https://github.com/sandstorm-io/sandstorm/blob/master/docs/administering/sample-config/nginx-example.conf) to `/etc/nginx/sites-enabled/`.

`nginx-example.conf` may be renamed to anything, such as `example.com.conf`. You'll need to make the following changes.


- All `server_name` lines should match the DNS hostnames for your Sandstorm install.
- Point `ssl_certificate` and `ssl_certificate_key` to your corresponding TLS certificate and key files.

Test your nginx configuration:
`sudo nginx -t`

### Configure Sandstorm's configuration files
Specify HTTPS, and remove port numbers from the base URL and wildcard host.

`/opt/sandstorm/sandstorm.conf`
```
BASE_URL=https://example.com
WILDCARD_HOST=*.example.com
```

If you need a custom port number, you should place it in `WILDCARD_HOST` as well as `BASE_URL`.

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
line. See the answer in the (frequently-asked questions
page.)[faq.md#how-do-i-log-in-if-theres-a-problem-with-logging-in-via-the-web]