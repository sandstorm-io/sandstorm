## Prerequisites
Create DNS entries for `example.com` and `*.example.com`.

Obtain or generate a key and TLS certificate with `example.com` and `*.example.com` in subjectAltName.

Install `nginx` with your package manager.

## Configuration

### NGINX
Copy [nginx-example.conf](https://github.com/sandstorm-io/sandstorm/blob/master/nginx-example.conf) to `/etc/nginx/sites-enabled/`.

`nginx-example.conf` may be renamed to anything, such as `example.com.conf`.

Alter the `conf` file.

- All `server_name` lines should match your DNS entries.
- Point `ssl_certificate` and `ssl_certificate_key` to your corresponding TLS certificate and key files.

```
listen 80;
server_name example.com *.example.com;

listen 443 ssl;
server_name example.com *.example.com;

ssl_certificate /etc/keys/example.com.crt;
ssl_certificate_key /etc/keys/example.com.key;
```

Test your NGINX configuration:
`sudo nginx -t`

### Sandstorm
Specify HTTPS, and remove port numbers from the base URL and wildcard host.

`/opt/sandstorm/sandstorm.conf`
```
BASE_URL=https://example.com
WILDCARD_HOST=*.example.com
```

## Run
Finally, start NGINX, and restart Sandstorm to use the new config.

```bash
sudo nginx
sudo /opt/sandstorm/sandstorm restart
```
