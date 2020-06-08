## Sandstorm and HTTPS

Sandstorm can now terminate TLS connections for most conventional configurations you may wish to employ.
This includes automatic certificate renewal of certificates, if you utilize a supported DNS provider, as well
as the ability to manually upload your own certificates, either self-signed or from a well-trusted certificate
vendor.

### How to get HTTPS on your Sandstorm install

If you are using a hostname like `example.sandcats.io`, then you likely already have working HTTPS for your
hostname. [This page](sandcats-https.md) provides help and advice for enabling and troubleshooting HTTPS for
Sandcats-based installs.

If you utilize a supported DNS provider (Sandcats.io, Cloudflare, Digital Ocean, DNSimple, Duck DNS, GoDaddy,
Gandi, Namecheap, Name.com, AWS Route 53, or Vultr), you can create an ACME account from "SSL/TLS Certificates"
admin panel to enable automatic certificate renewal. By default, this uses Let's Encrypt, however, you can use
any ACME service here.

If your certificate provider does not support ACME, and/or your DNS provider is not supported currently by
Sandstorm, you can manually upload your certificate.

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
  
- You [can follow this guide](https://web.archive.org/web/20190922195059/https://juanjoalvarez.net/es/detail/2017/jan/12/how-set-sandstorm-behind-reverse-proxy-keeping-you/)
  that explains how to use a [cron script](https://github.com/juanjux/sandstorm-sandcats-cert-installer) 
  to extract the certificates from your (sandcats.io enabled) Sandstorm installation to a location and 
  format where your reverse proxy can use them so it can serve Sandstorm by HTTPS, keeping your 
  sandcats.io domain and free auto-renewable certificates, along with any other services on your server.
