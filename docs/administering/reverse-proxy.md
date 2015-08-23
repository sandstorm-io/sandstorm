## Prerequisites
Obtain or generate two TLS certificates in total for `example.com` and `*.example.com`.

Install `nginx` with your package manager.

## Configuration
### NGINX
`/etc/nginx/sites-enabled/example.com.conf`
```
# Redirect to HTTPS
server {
  listen 80;
  server_name example.com *.example.com;
  return 301 https://$server_name$request_uri;
}

# HTTPS wildcard
server {
  listen 443;
  server_name *.example.com;

  location / {
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Host $http_host;
    proxy_pass http://127.0.0.1:6080;

    # Websocket
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  ssl on;
  ssl_certificate wildcard_example_com.crt;
  ssl_certificate_key wildcard_example_com.key;
}

# HTTPS
server {
  listen 443;
  server_name example.com;

  location / {
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Host $http_host;
    proxy_pass http://127.0.0.1:6080;
  }

  ssl on;
  ssl_certificate example_com.crt;
  ssl_certificate_key example_com.key;
}
```


### Sandstorm
Specify HTTPS, and remove port numbers from the base URL and wildcard host.

`/opt/sandstorm/sandstorm.conf`
```
BASE_URL=https://example.com
WILDCARD_HOST=*.example.com
```

Finally, start NGINX, and restart Sandstorm to use the new config.

```bash
sudo nginx
sudo /opt/sandstorm/sandstorm restart
```
