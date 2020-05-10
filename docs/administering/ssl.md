## Sandstorm and HTTPS

If you are using a hostname like `example.sandcats.io`, then you likely already have working HTTPS
(SSL) for your hostname. This page provides details on a variety of options for setting up HTTPS,
including the `sandcats.io` free certificates.

### How to get HTTPS on your Sandstorm install

You have a few options.

- Use [sandcats.io free HTTPS](sandcats-https.md), a free service of the Sandstorm.io company. Read
  details, including how to enable/disable, on that page. Sandstorm automatically renews these
  certificates, and they are valid in virtually all browsers.

- Run a [reverse proxy](reverse-proxy.md) such as nginx using a wildcard certificate that you
  acquire from a certificate vendor like GlobalSign. This is typically valid in all browsers and
  [costs some money](https://www.google.com/search?q=cheap+wildcard+ssl).

- Set up a [custom certificate authority](self-signed.md) for you and your server, also known as
  self-signed SSL. This will only be valid for browsers that you configure accordingly.

To share port 443 with other services on the same machine:

- You [can install `sniproxy` to share port 443](sniproxy.md) between your existing server and Sandstorm so that
  Sandstorm can manage (and autorenew) its own certificates. This allows you to combine an **existing
  web server on port 443** with free sandcats.io HTTPS.
  
- You [can follow this guide](https://web.archive.org/web/20190922195059/https://juanjoalvarez.net/es/detail/2017/jan/12/how-set-sandstorm-behind-reverse-proxy-keeping-you/)
  that explains how to use a [cron script](https://github.com/juanjux/sandstorm-sandcats-cert-installer) 
  to extract the certificates from your (sandcats.io enabled) Sandstorm installation to a location and 
  format where your reverse proxy can use them so it can serve Sandstorm by HTTPS, keeping your 
  sandcats.io domain and free auto-renewable certificates, along with any other services on your server.
