<!--

(Using an HTML comment to comment out documentation that we want users not
to see, but that I want to write right now.

## Sandstorm and HTTPS

### Automatic HTTPS for Sandcats.io users (PROPOSED)

**NOTE**: This section documents PROPOSED NEW behavior of Sandstorm, not behavior that works today.

For new Sandstorm installations, HTTPS is (in the future) enabled by
default. Sandstorm listens on port 443 for HTTPS connections and port
80 for HTTP connections.

When HTTPS mode is enabled (by setting the `HTTPS_PORT` configuration
option), the Sandstorm software (in the future) uses port 443 for all
traffic to the Sandstorm shell. If any requests come in on port 80,
Sandstorm serves a HTTP redirect.

Sandstorm grains can publish static content to the web on whatever
domain the user wants. Since the Sandstorm software can't currently
get a valid HTTPS certificate for all domain names, it serves static
publishing content over HTTP as well as HTTPS.

#### Enabling HTTPS for an existing Sandstorm server

**NOTE**: This section documents PROPOSED NEW behavior of Sandstorm, not behavior that works today.

If you are using the `sandcats.io` DNS service, you can (in the
future) migrate from running Sandstorm on port 6080 (perhaps with a
reverse-proxy) to having Sandstorm own port 443 (HTTPS) and port 80
(HTTP).

In this example, we presume your server is on
_example.sandcats.io_. We also assume your Sandstorm server runs on
port 6080 currently.

This process will require reconfiguring any OAuth login providers like
Google or GitHub, so it may take you up to thirty minutes to complete.

First, enable HTTPS by (in the future) by modifying your Sandstorm
configuration file (`sudo nano -w /opt/sandstorm/sandstorm.conf`) to add a
`HTTPS_PORT=` configuration value as follows.

```bash
HTTPS_PORT=443
```

Now, stop and start Sandstorm:

```bash
sudo sandstorm stop
sudo sandstorm start
```

Sandstorm will continue to operate as before on port 6080. In
addition, Sandstorm will log a message in
`/opt/sandstorm/var/log/sandstorm.log` indicating it is retrieving a
HTTPS certificate for you to use. This process can take about two
minutes. You can read that log by running:

```bash
sudo tail -f /opt/sandstorm/var/log/sandstorm.log
```

Once you see a message indicating `Sandstorm has successfully received
a HTTPS certificate`, it is safe to reconfigure Sandstorm to use HTTPS
by default. To do that, make the following changes to your
`sandstorm.conf` file.

```bash
PORT=80,6080
HTTPS_PORT=443
BASE_URL=https://example.sandcats.io
WILDCARD_HOST=*.example.sandcats.io
```

If you chose the default HTTPS port (443), you do not need to specify
a port number in the `BASE_URL` or `WILDCARD_HOST`. We recommend this
configuration with multiple `PORT=` values so that Sandstorm listens
on two standard ports, 443 (HTTPS) and 80 (HTTP), and still listens on
port 6080 in case anyone else links to your server on port 6080.

Having made these changes, you will need to restart Sandstorm.

```bash
sudo sandstorm stop
sudo sandstorm start
```

You can now visit your

*NOTE* that if you had Google or GitHub login enabled (or other OAuth
providers), the change in `BASE_URL` means that you need to
reconfigure those services. You can log into Sandstorm in a special admin
mode by running:

```bash
sudo sandstorm admin-token
```

and follow the prompts to configure Google and/or GitHub login
again. Once you have saved those settings, sign in via the top-right
corner of Sandstorm.

**Congratulations!** You're now using HTTPS, also known as TLS and
SSL.

### How multiple ports affect the shell, grains, and static publishing

When HTTPS is enabled, Sandstorm (in the future) serves its interface
(the shell and all grains) over HTTPS only. If such a request destined
on any other port, Sandstorm responds with a HTTP redirect to the
HTTPS version.

Sandstorm serves (in the future) static publishing content on HTTPS as
well as HTTP (ports 6080 and 80 in the above configuration). This way,
if you use WordPress or other publishing apps on Sandstorm, visitors
can reach those sites even if you do not have a valid HTTPS
certificate for those domain names.

This will result in duplicate content, where the same web pages are
available on port 80 and 6080. Based on our understanding of [how
duplicate content is handled by search
engines](https://support.google.com/webmasters/answer/66359?hl=en),
this will not be a problem for your site's ranking. In the long run,
consider turning off port 6080 by removing it from the `PORT=` line.
If you think the Sandstorm code should support something more
complicated involving (for example) HTTP redirects, please file a bug
so we can make sure we're serving your needs.

-->

## Self-hosted HTTPS with a custom certificate authority

The following is a process for self-hosted instances of Sandstorm to use SSL with sandcats.io DNS. These steps create a Certificate Authority (CA), corresponding CA Certificate, and the private and public keys for the `[anything].sandcats.io` and `*.[anything].sandcats.io` domains.

**Note**: Web browsers will display a big red certificate error when you try to connect to this install. This tutorial is appropriate if you are OK with reconfiguring web browsers to trust a custom certificate authority that you will create during this tutorial. For automatically-trusted SSL configuration, you will need to buy a certificate from a certificate authority.

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
    _

4. **Sign the Certificate Authority (CA) Key and Create Certificate Authority (CA) certificate (Expires in 10 years):**

        openssl req -x509 -new -nodes -key rootCA.key -days 3650 -out rootCA.pem

    `rootCA.pem` is the file for the Certificate Authority (CA) certificate
    _

5. **Create Sandstorm Device Private Key:**

        openssl genrsa -out sandstorm.key 4096

    `sandstorm.key` is the Sandstorm Device Private Key
    _

6. **Create Sandstorm Device Certificate Signing Request (CSR) using the copied and edited openssl.cnf file:**

        openssl req -new -key sandstorm.key -out sandstorm.csr -config openssl.cnf

    `sandstorm.csr` is the Sandstorm Device Certificate Signing Request (CSR)
    _

7. **Create and sign the Sandstorm Certificate (Expire in 2 years):**

        openssl x509 -req -in sandstorm.csr -CA rootCA.pem -CAkey rootCA.key -CAcreateserial -out sandstorm.crt -days 730 -extensions v3_req -extfile openssl.cnf

    `sandstorm.crt` is the Sandstorm Certificate
    _

8. **Import the Certificate Authority (CA) Certificate (`rootCA.pem`) into the browser's that will be using Sandstorm. Some browsers may load grains without this step and ask users to add a security excpetion in order to fully load grains.**
_

9. **Copy (FTP/SSH) the Sandstorm Certificate and Sandstorm Private Key to the nginx ssl directory, it may be `/etc/nginx/ssl`**.
_

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
