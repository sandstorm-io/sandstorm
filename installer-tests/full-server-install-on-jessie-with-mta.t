Title: Ensure that Sandstorm installs OK when there is a MTA
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm_and_postfix

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]sudo dpkg --configure -a && sudo apt-get -f -y install && echo dpkg-fixed
$[veryslow]dpkg-fixed
$[run]sudo DEBIAN_FRONTEND=noninteractive apt-get install -d -y --no-install-recommends postfix && echo postfix-downloaded
$[veryslow]postfix-downloaded
$[run]printf "\x23\x21/bin/sh\nexit 101\n" | sudo dd of=/usr/sbin/policy-rc.d && sudo chmod 755 /usr/sbin/policy-rc.d && echo policy-rc.d-configured
$[slow]policy-rc.d-configured
$[run]sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postfix && echo postfix-installed
$[veryslow]postfix-installed
$[run]sudo service postfix start && echo postfix-started
$[veryslow]postfix-started
$[run]for i in `seq 0 20`; do nc -z localhost 25 && { echo postfix-bound-port-25; break; } || sleep 1 ; done
$[veryslow]postfix-bound-port-25
$[run]CURL_USER_AGENT=testing REPORT=no OVERRIDE_SANDCATS_BASE_DOMAIN=sandcats-dev.sandstorm.io OVERRIDE_SANDCATS_API_BASE=https://sandcats-dev-machine.sandstorm.io OVERRIDE_SANDCATS_CURL_PARAMS=-k bash /vagrant/install.sh -i
$[slow]Sandstorm makes it easy to run web apps on your own server. You can have:

1. A typical install, to use Sandstorm (press enter to accept this default)
2. A development server, for working on Sandstorm itself or localhost-based app development

How are you going to use this Sandstorm install? [1] $[type]1
We're going to:

* Install Sandstorm in /opt/sandstorm
* Automatically keep Sandstorm up-to-date
* Create a service user (sandstorm) that owns Sandstorm's files
* Configure Sandstorm to start on system boot (with sysvinit)
* Configure your system to enable unprivileged user namespaces, via sysctl.

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
$[veryslow]Sandstorm started. PID =
Visit this link to start using it:
  http://
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
