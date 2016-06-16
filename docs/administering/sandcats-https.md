## Sandstorm's built-in HTTPS (if you use a `sandcats.io` domain)

For new Sandstorm installations, HTTPS is enabled by
default. Sandstorm listens on port 443 for HTTPS connections and port
80 for HTTP connections. To read about other options for configuring
HTTPS/SSL, visit the [HTTPS/SSL topic guide](ssl.md).

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
clients](http://caniuse.com/#feat=sni).  This is because Sandstorm
relies on nodejs's `SNICallback` API to smoothly start using new
certificates without restarting the server. Therefore, Sandstorm's
built-in HTTPS support presents an invalid certificate for
`client-does-not-support-sni.sandstorm-requires-sni.invalid` to
clients that can't speak SNI to clarify that SNI is required. If you
need your Sandstorm installation to support non-SNI clients, you will
need to use a custom HTTPS terminator, or file a bug against Sandstorm.

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
