Title: Ensure that Sandstorm can work on centos7
Vagrant-Box: centos7
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]curl https://raw.githubusercontent.com/sandstorm-io/sandstorm/a7280469b582c197bc82a08adfc891993124568c/install.sh > /tmp/install.sh && echo done
$[veryslow]done
$[run]curl https://patch-diff.githubusercontent.com/raw/sandstorm-io/sandstorm/pull/2670.diff > /tmp/diff.diff && echo done
$[veryslow]done
$[run]sudo yum install -y patch && echo done
$[veryslow]done
$[run]patch -p1 /tmp/install.sh < /tmp/diff.diff && echo done
$[slow]done
$[run]CURL_USER_AGENT=testing REPORT=no OVERRIDE_SANDCATS_BASE_DOMAIN=sandcats-dev.sandstorm.io OVERRIDE_SANDCATS_API_BASE=https://sandcats-dev-machine.sandstorm.io OVERRIDE_SANDCATS_CURL_PARAMS=-k OVERRIDE_NC_PATH=/usr/bin/ncat bash /tmp/install.sh -i
$[slow]Sandstorm makes it easy to run web apps on your own server. You can have:

1. A typical install, to use Sandstorm (press enter to accept this default)
2. A development server, for working on Sandstorm itself or localhost-based app development

How are you going to use this Sandstorm install? [1] $[type]1
We're going to:

* Install Sandstorm in /opt/sandstorm
* Automatically keep Sandstorm up-to-date
* Create a service user (sandstorm) that owns Sandstorm's files
* Configure Sandstorm to start on system boot (with systemd)

To set up Sandstorm, we will need to use sudo.
OK to continue? [yes] $[type]
$[slow]Re-running script as root...
$[slow]As a Sandstorm user, you are invited to use a free Internet hostname as a subdomain of sandcats.io
$[slow]Choose your desired Sandcats subdomain (alphanumeric, max 20 characters).
Type the word none to skip this step, or help for help.
What *.sandcats-dev.sandstorm.io subdomain would you like? []$[type]gensym
We need your email on file so we can help you recover your domain if you lose access. No spam.
Enter your email address: [] $[type]install-script@asheesh.org
Registering your domain.
$[slow]Congratulations! We have registered your
Your credentials to use it are in /opt/sandstorm/var/sandcats; consider making a backup.
$[veryslow]Downloading: https://dl.sandstorm.io
$[veryslow]GPG signature is valid.
$[veryslow]Your server is coming online. Waiting up to 90 seconds...
$[veryslow]Visit this link to start using it:
  http://
To learn how to control the server, run:
  sandstorm help
$[exitcode]0

