## Sandstorm and HTTPS

Sandstorm can terminate TLS connections for most conventional configurations you may wish to employ. This
includes automatic certificate renewal of certificates if you use a supported DNS provider, as well as the
ability to manually upload your own certificates, either self-signed or from a well-trusted certificate vendor.

### How to get HTTPS on your Sandstorm install

If you are using a hostname like `example.sandcats.io`, then you likely already have working HTTPS for your
hostname. [This page](sandcats-https.md) provides help and advice for enabling and troubleshooting HTTPS for
Sandcats-based installs.

If you use a supported DNS provider, you can create an ACME account from "SSL/TLS Certificates" admin panel
to enable automatic certificate renewal. By default, this uses Let's Encrypt, however, you can use any ACME
service here.

Sandstorm supports automatic renewal with the following DNS providers:
- Sandcats.io
- Cloudflare
- Digital Ocean
- DNSimple
- Duck DNS
- GoDaddy
- Gandi
- Namecheap
- Name.com
- Route 53 (AWS)
- Vultr

If your certificate provider does not support ACME, and/or your DNS provider is not supported currently by
Sandstorm, you can manually upload your certificate.

### Options JSON

When configuring ACME support, many providers will require an "options JSON". The required values can vary
between providers, but often just a `token` and optionally a `baseUrl` are used. The token is generally an
API key with the permissions to read and edit your DNS zone for the domain you are using for Sandstorm.

Both Cloudflare and Gandi, for example, accept the following:

```json
{ "token": "xxx" }
```

You can find the documentation for the various providers in their [respective npm packages](https://www.npmjs.com/search?q=acme-dns-01-),
however, note that our Options JSON field requires double quotes, as above, around both the key and value.

### Additional options

- Run a [reverse proxy](reverse-proxy.md) such as nginx using a wildcard certificate that you
  acquire from a certificate vendor.

- Set up a [custom certificate authority](self-signed.md) for you and your server, also known as
  self-signed SSL. This will only be valid for browsers that you configure accordingly. This tutorial assumes
  you are utilizing a reverse proxy.

To share port 443 with other services on the same machine:

- You [can install `sniproxy` to share port 443](sniproxy.md) between your existing server and Sandstorm so that
  Sandstorm can manage (and autorenew) its own certificates. This allows you to combine an **existing
  web server on port 443** with Sandstorm.

- You [can follow this guide](https://juanjoalvarez.net/es/detail/2017/jan/12/how-set-sandstorm-behind-reverse-proxy-keeping-you/)
  that explains how to use a cron script to extract the certificates from your installation with
  Sandstorm-managed TLS. Please note that the version of the script used in the guide before June 2020 
  did not work with new Sandstorm versions so if you already did that but your site
  stopped working use the [updated script](https://github.com/Michael-S/sandstorm_certs_extract_cron). The extracted
  certificates will be used by your reverse proxy to server Sandstorm by HTTPS along with any other services
  on your server.
