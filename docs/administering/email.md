# Email in Sandstorm

This tutorial will show you how to setup your personal sandstorm instance with support for e-mail.

First, a quick rundown of how email works in sandstorm. Sandstorm is
running an SMTP server on port 30025 that will accept email of the
form `publicId`@`hostname`. `publicId` is randomly generated for every
grain that handles e-mail, and `hostname` is extracted from the
`BASE_URL` parameter in sandstorm.conf (which is initially created by
the installer script). Outgoing e-mail is sent through an external
SMTP server, controllable from the Admin settings -> Email configuration page.
(Note that the `MAIL_URL` parameter in `sandstorm.conf` has been
deprecated.) When sending e-mails, the only valid "From" addresses are
the grain's generated `publicId`@`hostname` address, or the verified
email from the user's account (e.g. the e-mail address obtained via
e.g. Google or Github or email login). The interfaces for sending/receiving e-mails
are available in
[hack-session.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/hack-session.capnp).

## Outgoing SMTP

Apps can send email out to the world, subject to rate limiting. To enable this feature, you must
configure an SMTP relay in the `Email configuration` page of the Admin panel.  The SMTP server needs
to accept e-mails with the SMTP envelope's bounce address set to either your grain's local address
or the "Sandstorm server's own email address" address.

If running at home or at work, you can usually use your ISP's or corporation's SMTP
server. Otherwise, [Sendgrid](https://sendgrid.com/), [Mailgun](http://www.mailgun.com/), and others
provide SMTP services, some with free tiers. Note in our testing, Google Gmail is incompatible with
the Sandstorm outbound SMTP requirements: it will modify the From header and SMTP envelope to be
your personal address, rather than what the app specified. Therefore it may seem to work for the
first user, but when you add other users to your server, any emails sent by their apps will appear
to come from you!

Some cloud providers block outbound port 25, which you may experience as Sandstorm reporting
"Connection timed out." In that case, check if your outbound SMTP provider supports alternative
ports such as 587 or 2525.

**sandcats.io users:** Since [the sandcats dynamic DNS & HTTPS service](sandcats.md) does not
support special DNS records that improve email deliverability, we recommend you configure a
**Server's own email address** on a domain you personally control, not your sandcats subdomain.
Then, be sure to use an SMTP provider to configure that domain and your DNS provider to configure
SPF/DKIM records.

## Receiving email into Sandstorm grains

To allow Sandstorm grains to receive email, you need to do the following.

- **Set up DNS for a domain:** Configure DNS so that other computers know how to deliver email to your server.

- **Configure port 25 on your server:** When email messages arrive on inbound port 25, they must
  reach Sandstorm. Sandstorm will then route them to any specific grain.

### Aside: How to test your configuration

One great way to test inbound email is to use the Roundcube app. To do that:

- Install [Roundcube](https://apps.sandstorm.io/app/0qhha1v9ne1p42s5jw7r6qq6rt5tcx80zpg1f5ptsg7ryr4hws1h)
  from the Sandstorm app market into an account on your Sandstorm server.

- Click **Create a mailbox** from Roundcube's app details page on your server.

- Click **Connect to Your Address** within a Roundcube grain. You should now see an inbound email
  address for this Roundcube grain of the form.

Once you know Roundcube's inbound email address, use a separate email system such as Gmail to send
it an email! If this test email appears within Roundcube, you can skip the rest of these steps!
Inbound emails should appear within 5 seconds of when you send them; if they do not, click
Roundcube's **Refresh** button to make sure.

### Set up DNS

Grains can receive inbound email, and their email adddresses are always of the form
`{{publicId}}@{{BASE_DOMAIN}}`. `{{BASE_DOMAIN}}` is the domain name value component of `BASE_URL`
in your `sandstorm.conf`. `{{publicId}}` is a random unique ID that is assigned to this grain by
Sandstorm. Therefore, the domain in your `BASE_URL` needs to have a DNS configuration that enables
inbound email.

**sandcats.io users:** No action is required. Servers on the Internet that send you email will
connect to the IP address of the DNS `A` record maintained by the sandcats.io service.

**Sandstorm users on your own domain:** No action is usually required, since presumably your
server's BASE_URL resolves properly to your Sandstorm server. For extra standards compliance, you
can add an `MX` record for the domain name that you use in your `BASE_URL`. You can use any number
as the MX priority, for example, `10`.

### Configure port 25, the easy way: Sandstorm can listen on port 25

By default, Sandstorm's SMTP server runs on port 30025. You can adjust it to listen on port 25.
This is the easiest way to configure inbound email; however, note that Sandstorm's SMTP server does
not support inbound STARTTLS at this time.

Make sure nothing else is running on port 25 on this system. Then edit
`/opt/sandstorm/sandstorm.conf` to add this new line:

```bash
SMTP_LISTEN_PORT=25
```

Now stop & start Sandstorm.

At this point, you should be able to test inbound email to your Roundcube grain.

### Configure port 25, the advanced way: Proxy SMTP

If you need to share Sandstorm's SMTP service with port 25 used by other services, or you want
inbound STARTTLS, you can configure Sandstorm's SMTP service to sit behind a reverse proxy. One way
to do accomplish this is with nginx. Add the following to your `nginx.conf`:

    mail {
        ssl_certificate /etc/keys/my-ssl.crt;
        ssl_certificate_key /etc/keys/my-ssl.key;
        ssl_session_timeout 5m;
        ssl_protocols TLSv1 TLSv1.1 TLSv1.2;
        ssl_ciphers ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:ECDH+3DES:DH+3DES:RSA+AESGCM:RSA+AES:RSA+3DES:!aNULL:!MD5:!DSS;
        ssl_prefer_server_ciphers on;

        server {
            listen 25;
            server_name sandstorm.example.com;
            auth_http localhost:8008/fake-smtp-auth;
            protocol smtp;
            timeout 30s;
            proxy on;
            xclient off;
            smtp_auth none;
            starttls on;
        }

        server {
            listen 465;
            server_name sandstorm.example.com;
            auth_http localhost:8008/fake-smtp-auth;
            protocol smtp;
            timeout 30s;
            proxy on;
            xclient off;
            smtp_auth none;
            ssl on;
        }
    }

nginx requires that you provide an authentication handler for all SMTP proxies. We don't actually
need authentication because our server is only meant to receive e-mail destined for this host (it
will not relay). So, we have to set up a fake authentication handler. In the part of your nginx
config where you defined your HTTP servers (e.g. `/etc/nginx/sites-available/default`), add this
fake server for SMTP auth purposes:

    # Fake SMTP authorizor which always accepts. Put this in your http block.
    server {
        listen 127.0.0.1:8008;
        server_name localhost;

        location /fake-smtp-auth {
            add_header Auth-Server 127.0.0.1;
            add_header Auth-Port 30025;
            return 200;
        }
    }
