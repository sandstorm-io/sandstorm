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

All you need to do is provide an appropriate SMTP relay in the `Email configuration` page of the
Admin panel.  Your configuration should point Sandstorm to a working SMTP server that will accept
e-mails with the SMTP envelope's bounce address set to your grain's local address, or to the
"Sandstorm server's own email address" address.

If running at home, you can usually use your ISP's SMTP server.
Otherwise, [Sendgrid](https://sendgrid.com/), [Mailgun](http://www.mailgun.com/), and
[Mandrill](http://mandrill.com/) also provide such services, some with free tiers.

## Receiving email into Sandstorm app instances

### Prerequisites

* A personal domain at which you are running your Sandstorm server.
* Basic knowledge of how to configure DNS records for your domain.
* nginx
* A working outgoing SMTP server.

### Setup DNS

This is relatively straightfoward if you know how to configure your domain's DNS records. All you need to do is add an MX record pointing to your sandstorm server.

### Proxy SMTP

Sandstorm's SMTP server runs on port 30025, and is intended to sit behind a reverse proxy. The easiest way to do accomplish this is with nginx. Add the following to your `nginx.conf`:

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

nginx requires that you provide an authentication handler for all SMTP proxies. We don't actually need authentication because our server is only meant to receive e-mail destined for this host (it will not relay). So, we have to set up a fake authentication handler. In the part of your nginx config where you defined your HTTP servers (e.g. `/etc/nginx/sites-available/default`), add this fake server for SMTP auth purposes:

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
