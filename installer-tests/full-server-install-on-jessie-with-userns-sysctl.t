Title: Can install with root on Debian jessie, in full server mode
Vagrant-Box: jessie
Vagrant-Precondition-bash: ! -d $HOME/sandstorm
Vagrant-Precondition-bash: ! -d /opt/sandstorm
Cleanup: uninstall_sandstorm(parsed_headers['vagrant-box'])

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]CURL_USER_AGENT=testing OVERRIDE_SANDCATS_BASE_DOMAIN=sandcats-dev.sandstorm.io OVERRIDE_SANDCATS_API_BASE=https://sandcats-dev-machine.sandstorm.io OVERRIDE_SANDCATS_CURL_PARAMS=-k bash /vagrant/install.sh
$[slow]Sandstorm makes it easy to run web apps on your own server. You can have:

1. A full server with automatic setup (press enter to accept this default)
2. A development server, for writing apps.

How are you going to use this Sandstorm install? [1] $[type]1
We're going to:

* Install Sandstorm in /opt/sandstorm
* Automatically keep Sandstorm up-to-date
* Create a service user (sandstorm) that owns Sandstorm's files
* Configure Sandstorm to start on System boot (with sysvinit)
* Configure your system to enable unprivileged user namespaces, via sysctl.

To set up Sandstorm, we will need to use sudo.
OK to continue? [yes] $[type]
$[slow]Re-running script as root...
As a Sandstorm user, you are invited to use a free Internet hostname as a subdomain of sandcats.io.
$[slow]Choose your desired Sandcats subdomain (alphanumeric, max 20 characters).
Type the word none to skip this step, or help for help.
What *.sandcats-dev.sandstorm.io subdomain would you like? []$[type]gensym
We need your email on file so we can help you recover your domain if you lose access. No spam.
Enter your email address: [] $[type]install-script@asheesh.org
Registering your domain.
$[slow]Congratulations! We have registered your
Your credentials to use it are in /opt/sandstorm/var/sandcats; consider making a backup.
$[slow]Downloading: https://dl.sandstorm.io
$[slow]Sandstorm started. PID =
Setup complete. You should configure the site at:
  http://
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
$[run]sudo bash -c 'echo 0 > /proc/sys/kernel/unprivileged_userns_clone'
$[slow]0
