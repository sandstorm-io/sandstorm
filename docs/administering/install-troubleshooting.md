## Have you tried...?

If you just installed Sandstorm, and it does not seem to be working, here is a list of things you
can try, with the most important things first.

## Can you reach your Sandstorm server using a web browser?

If your Sandstorm server should be online at https://example.sandcats.io/ , try
visiting that page in your web browser.

If that works, great!

If you see a strange OCSP warning message, you can try using Chrome rather than Firefox. The warning
will resolve itself after about 10 minutes. This is due to GlobalSign's APIs sometimes being slow.

## Is Sandstorm running?

You can usually find this out by running:

```bash
sudo sandstorm status
```

and/or

```bash
sudo service sandstorm status
```

and/or

```bash
sudo systemctl status sandstorm.service
```

If it is not running, you need to find out why and/or start it. You can find out why Sandstorm isn't
starting by reading its log file. If you need to start Sandstorm, you can try the above commands
with `status` replaced with `start`.

## Is there something surprising in the Sandstorm log file?

Take a look at this file on your Sandstorm server:

- /opt/sandstorm/var/log/sandstorm.log

Feel free to share the contents of the log file in the [#sandstorm chat
room](https://sandstorm.io/community). Consider uploading it to a pastebin, rather than pasting the
whole file into IRC.  A common pastebin to use is [gist.github.com.](https://gist.github.com/) The
Sandstorm core team has attempted to ensure that your Sandstorm log does not contain any private
information to you, but feel very free to read the log file before sharing it.

## Do you need to configure/reconfigure port forwarding?

If your Sandstorm server is located within a e.g. home network, you often need to set up port
forwarding. See also [portforward.com's guide to port forwarding.](http://portforward.com/)

If your Sandstorm server's internal IP address changes, then your port forwarding information might
be out of date. Consider setting up a "static IP" on the computer running Sandstorm, if that is the
case. See [portforward.com's tutorial about static
IPs](http://portforward.com/networking/staticip.htm) to learn about static IP addresses.

If you're using sandcats HTTPS, make *sure* you forward both port 443 and port 80. Here's why: Your
browser will default to HTTP (port 80) when you type your hostname into Chrome/Firefox/etc. If you
enable port 80 (which you should do), then Sandstorm will be able to redirect the request to HTTPS
(port 443). Having said that, if you know what you are doing, it can be OK to only forward port 443.
If you're concerned about the `sslstrip` attack (read more: [1]http://security.stackexchange.com/questions/41988/how-does-sslstrip-work] [2](https://www.happybearsoftware.com/you-should-be-more-worried-about-sslstrip) [3](https://www.linkedin.com/pulse/ssl-stripping-newbies-avinash-sm))

## Do you have a "hairpin routing" problem?

If you are using port forwarding, and you can't access your server from inside your network, then:

- Check if it's reachable from the outside world. It might be reachable from the outside world, even
  if you can't reach it inside your network. Try using your phone (with wifi disabled), or ["Down
  For Everyone Or Just Me?"](http://www.downforeveryoneorjustme.com/), to check.

- If it is, your router might have a problem with "hairpinning", see these
  [two](https://en.wikipedia.org/wiki/Hairpinning)
  [articles.](https://en.wikipedia.org/wiki/Network_address_translation#NAT_loopback)

This sort of problem is typically hard to correct for without changing your wifi router. If your
wifi router supports internal DNS entries, you can configure that. To read more about that,
see here:

- [Stack Overflow article about dnsmasq wildcard
  DNS](http://stackoverflow.com/questions/22313142/wildcard-subdomains-with-dnsmasq)

## Is another process listening on Sandstorm's ports, preventing it from starting?

Sometimes Sandstorm installs properly, and then a later system configuration change prevents it from
starting. One reason for that is if you use YUM or APT to install another web server like Apache2 or
nginx, resulting in Sandstorm no longer being able to bind its TCP ports.  This will result in
Sandstorm failing to start. You'll see an error messages in the Sandstorm log like:

```bash
sandstorm/util.c++:845: fatal: *exception = sandstorm/run-bundle.c++:1872: failed: bind(sockFd, reinterpret_cast<sockaddr *>(&sa), sizeof(sockaddr_in)): Address already in use
```

To fix this, you'll need to find out what other program is listening on the ports your Sandstorm
install uses.

First, check what ports those are by running:

```bash
grep PORT /opt/sandstorm/sandstorm.conf
```

You should see some port numbers for HTTP (called PORT=), MongoDB (called MONGO_PORT=), and
optionally HTTPS (called HTTPS_PORT=). Typically the HTTP port is 80, and the HTTPS_PORT is 443 (if
present), and the MONGO_PORT is 6081.

You can search your system to see what program is listening on e.g. port 80 by running this command. You might have to install lsof with e.g. `apt-get install lsof`.

```bash
lsof -n -P -i :80
```

For example, if the program is nginx, you can remove it with this command. Note that in Debian and
Ubuntu, nginx installs many packages; this command is designed to remove all of them.

```bash
sudo apt-get remove 'nginx-*'
```

Once you have done that, you should restart Sandstorm with a command such as the following.

```bash
sudo service sandstorm restart
```

This should resolve your problems. If not, please get in touch.

## Are grains not starting on Ubuntu 24.04 or later?

If your wildcard DNS is configured correctly, you should see the app icons correctly on the apps tab. If
grains are not starting, and you are on Ubuntu 24.04 or later, AppArmor may be restricting unprivileged
user namespaces. You can run the following commands to correct this:

```bash
sudo sh -c 'echo "kernel.apparmor_restrict_unprivileged_userns = 0" > /etc/sysctl.d/sandstorm-userns.conf'
sudo sysctl --system
sudo service sandstorm restart
```

As of this writing, this restriction is very uncommon in Linux distributions, but you may wish to consult
updated guidance. An AppArmor profile for Sandstorm would be a welcome contribution.

## Did you disable outside collaborators before attempting to configure Google or GitHub login methods?

The setting "Disallow collaboration with users outside the organization" is intended for servers using
organization-based login providers such as LDAP, OIDC, SAML, or an email address belonging to an organization
email domain. If you are going to set up consumer Google or GitHub OAuth, you should not select this option.

## Does outbound email truly work?

You can use the admin configuration panel to test outbound email. Make sure you successfully receive
the test email! If not, then you should de-configure email within your Sandstorm server so that it
doesn't try to use a broken email setup.

If you are having trouble disabling/reconfiguring outbound email, do the following:

- Create an "admin token" and go back into the setup wizard by running: `sudo sandstorm admin-token`

- Click "next" a few times until you find configuration options related to email.

- Change them, and save them.

For what it is worth, Sandstorm can function OK without email (though some features require
email). However, Sandstorm often acts strangely if Sandstorm thinks email works, but in fact it
doesn't.
