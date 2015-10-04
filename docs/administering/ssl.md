## Sandstorm and HTTPS

If you are using a hostname like `example.sandcats.io`, then you
likely already have working HTTPS (SSL) for your hostname. Keep
reading to learn how this feature works and enable it/disable it.

This page also documents other options for HTTPS for a Sandstorm
server.

### Sandstorm's built-in HTTPS (if you use a `sandcats.io` domain)

For new Sandstorm installations, HTTPS is enabled by
default. Sandstorm listens on port 443 for HTTPS connections and port
80 for HTTP connections.

This is implemented through the `sandstorm.conf` file. HTTPS mode is
enabled by setting the `HTTPS_PORT=443` configuration option, causing
the Sandstorm software on your server to bind port 443.

Sandstorm also listens on port 80 (via `PORT=80`). When there is a
`HTTPS_PORT` configured, and a request comes in for the Sandstorm
shell or a wildcard host over HTTP, Sandstorm delivers a redirect to
HTTPS.

Sandstorm grains can publish static content to the web on whatever
domain the user wants. Sandstorm serves this static publishing over
both HTTP and HTTPS, since Sandstorm software can't currently get a
valid HTTPS certificate for all domain names.

#### Enabling HTTPS for an existing `sandcats.io` Sandstorm server

If you are using the `sandcats.io` DNS service, you can migrate from
running Sandstorm on port 6080 (perhaps with a reverse-proxy) to
having Sandstorm own port 443 (HTTPS) and port 80 (HTTP).

If you are using nginx to speak HTTPS on port 443 and HTTP on port 80,
you should disable that before proceeding.

In this example, we presume your server is on
_example.sandcats.io_. We also assume your Sandstorm server runs on
port 6080 currently.

This process will require reconfiguring any OAuth login providers like
Google or GitHub, so it may take you up to thirty minutes to complete.

First, enable HTTPS by modifying your Sandstorm configuration file.
One way to do that is to open it with nano:

```bash
sudo nano -w /opt/sandstorm/sandstorm.conf
```

Add `HTTPS_PORT=` to the bottom of the file:

```bash
HTTPS_PORT=443
```

Find these settings and modify them:

```bash
BASE_URL=https://example.sandcats.io
WILDCARD_HOST=*.example.sandcats.io
PORT=80,6080
```

**Note on customization:** if you stick to the default `HTTPS_PORT` of
443, make sure to remove `:6080` from `BASE_URL` and
`WILDCARD_HOST`. If you prefer a non-default port, you must specify it
in `BASE_URL` and `WILDCARD_HOST`. If you want Sandstorm to listen for
HTTP on ports other than 80, you can customize the `PORT=` line.

Save the file and exit your editor. If you are using `nano` you can
do this `Ctrl-w` then `enter` then `Ctrl-x`.

Stop and start Sandstorm:

```bash
sudo sandstorm restart
```

Sandstorm will begin to set up HTTPS, and if you want to watch the
process, you can run this command:

```bash
sudo tail -f /opt/sandstorm/var/log/sandstorm.log
```

The first launch with HTTPS enabled may take one or two minutes while
Sandstorm configures keys.

**Note on login providers**: If you had Google or GitHub login enabled
(or other OAuth providers), the change in `BASE_URL` means that you
need to reconfigure those services. You can log into Sandstorm in a
special admin mode by running:

```bash
sudo sandstorm admin-token
```

Once you are viewing the admin page, you should disable and then
re-enable GitHub, Google, and any other OAuth-based login
providers. This process will typically require visiting the Google and
GitHub websites.

Once you click **Save** at the bottom of the login configuration page,
you should sign in however you normally sign in, perhaps with a Google
or GitHub account, by clicking **Sign in**.

**Congratulations!** You're now using HTTPS, also known as SSL and TLS.

### Technical details

**Automatic renewal.** Sandstorm's built-in HTTPS uses the
[Sandcats.io service](sandcats.md) to renew certificates without
needing any manual intervention.

<!--
**B rating.** Sandstorm's HTTPS cipher suites are kind of OK but really
could be better.
-->

**No reverse proxy.** This configuration removes the need for a
reverse proxy or HTTPS terminator like `nginx`. If you want to set up
a reverse proxy, you would typically use `BIND_IP=127.0.0.1` and
`PORT=6080` and choose a `BASE_URL` that reflects your external URL.

**Server Name Indication (SNI) is required.** Sandstorm's built-in
HTTPS support requires its clients to support Server Name Indication
(SNI), which at the time of writing is supported by [over 97% of web
clients[(http://caniuse.com/#feat=sni).  This is because Sandstorm
relies on nodejs's `SNICallback` API to smoothly start using new
certificates without restarting the server. Therefore, Sandstorm's
built-in HTTPS support presents an invalid certificate for
`client-does-not-support-sni.sandstorm-requires-sni.invalid` to
clients that can't speak SNI to clarify that SNI is required. If you
need your Sandstorm installation to support non-SNI clients, you will
need to use a custom HTTPS teminator, or file a bug against Sandstorm.

**Duplicate content on multiple ports.** If you are publishing content
at `example.com` and specify multiple values for `PORT=`, the content
is available on each port. We used to be concerned that this might
negatively affect how sites hosted on Sandstorm are ranked in search
engines; our research on [how duplicate content is handled by search
engines](https://support.google.com/webmasters/answer/66359?hl=en)
reassures us that this will not be a problem. In the long run,
consider turning off port 6080 by removing it from the `PORT=` line.
If you think the Sandstorm code should support some customization on
how it handles multiple ports, please file a bug so we can make sure
we're serving your needs.

## Self-hosted HTTPS with a custom certificate authority

The following is a process for self-hosted instances of Sandstorm to use SSL with sandcats.io DNS. These steps create a Certificate Authority (CA), corresponding CA Certificate, and the private and public keys for the `[anything].sandcats.io` and `*.[anything].sandcats.io` domains.

**Note**: Web browsers will display a big red certificate error when you try to connect to this install. This tutorial is appropriate if you are OK with reconfiguring web browsers to trust a custom certificate authority that you will create during this tutorial. For automatically-trusted SSL configuration, you will need to use a sandcats.io hostname or follow instructions from a certificate authority.

1. **Make a copy openssl.cnf:**

        cp /etc/ssl/openssl.cnf [directory_you_want_copy_to_be]


2. **Add the following to the end of the copied `openssl.cnf` file:**

        [req]
        req_extensions = v3_req

        [ v3_req ]

        # Extensions to add to a certificate request

        basicConstraints = CA:FALSE
        keyUsage = nonRepudiation, digitalSignature, keyEncipherment
        subjectAltName = @alt_names

        [alt_names]
        DNS.1 = [your-domain-name].sandcats.io
        DNS.2 = *.[your-domain-name].sandcats.io

3. **Create the Certificate Authority (CA) Key:**

        openssl genrsa -out rootCA.key 4096
    `rootCA.key` is the file for the Certificate Authority (CA) key.


4. **Sign the Certificate Authority (CA) Key and Create Certificate Authority (CA) certificate (Expires in 10 years):**

        openssl req -x509 -new -nodes -key rootCA.key -days 3650 -out rootCA.pem

    `rootCA.pem` is the file for the Certificate Authority (CA) certificate


5. **Create Sandstorm Device Private Key:**

        openssl genrsa -out sandstorm.key 4096

    `sandstorm.key` is the Sandstorm Device Private Key


6. **Create Sandstorm Device Certificate Signing Request (CSR) using the copied and edited openssl.cnf file:**

        openssl req -new -key sandstorm.key -out sandstorm.csr -config openssl.cnf

    `sandstorm.csr` is the Sandstorm Device Certificate Signing Request (CSR)


7. **Create and sign the Sandstorm Certificate (Expire in 2 years):**

        openssl x509 -req -in sandstorm.csr -CA rootCA.pem -CAkey rootCA.key -CAcreateserial -out sandstorm.crt -days 730 -extensions v3_req -extfile openssl.cnf

    `sandstorm.crt` is the Sandstorm Certificate


8. **Import the Certificate Authority (CA) Certificate (`rootCA.pem`) into the browser's that will be using Sandstorm. Some browsers may load grains without this step and ask users to add a security excpetion in order to fully load grains.**

9. **Copy (FTP/SSH) the Sandstorm Certificate and Sandstorm Private Key to the nginx ssl directory, it may be `/etc/nginx/ssl`**.


10. **Change these lines in your nginx conf file to reflect the new Sandstorm Certificate and Private Key filenames**:

        ssl_certificate /etc/nginx/ssl/sandstorm.crt;
        ssl_certificate_key /etc/nginx/ssl/sandstorm.key;

11. **Restart nginx**:

        sudo service nginx restart

12. **Restart Sandstorm:**

        sudo sandstorm restart
    or

        sudo /opt/sandstorm/sandstorm restart


Created with help from:

* [https://docs.sandstorm.io/en/latest/administering/reverse-proxy/](https://docs.sandstorm.io/en/latest/administering/reverse-proxy/)
* [http://datacenteroverlords.com/2012/03/01/creating-your-own-ssl-certificate-authority/](http://datacenteroverlords.com/2012/03/01/creating-your-own-ssl-certificate-authority/)
* [https://wiki.cacert.org/FAQ/subjectAltName](https://wiki.cacert.org/FAQ/subjectAltName)
* [http://www.codeproject.com/Tips/833087/X-SSL-Certificates-With-Custom-Extensions](http://www.codeproject.com/Tips/833087/X-SSL-Certificates-With-Custom-Extensions)
* [http://markmail.org/message/grfu4qkr5v5xttc2](http://markmail.org/message/grfu4qkr5v5xttc2)
* [http://blog.loftninjas.org/2008/11/11/configuring-ssl-requests-with-subjectaltname-with-openssl/](http://blog.loftninjas.org/2008/11/11/configuring-ssl-requests-with-subjectaltname-with-openssl/)
