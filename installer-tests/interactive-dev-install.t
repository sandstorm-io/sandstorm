Title: Auto-install with root on Debian jessie, in dev mode, showing $SUDO_USER
Vagrant-Box: jessie
Vagrant-Precondition-bash: ! -d $HOME/sandstorm
Vagrant-Precondition-bash: ! -d /opt/sandstorm
Cleanup: uninstall_sandstorm(parsed_headers['vagrant-box'])

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]CURL_USER_AGENT=testing bash /vagrant/install.sh
$[slow]How are you going to use this Sandstorm install? [1]$[type]2
OK to continue? [yes]$[type]
$[slow]We're going to:
* Add you (vagrant) to the sandstorm group so you can read/write app data.
Press enter to accept defaults. Type 'no' to customize. [yes]$[type]
Config written to /opt/sandstorm/sandstorm.conf.
Finding latest build for dev channel...
$[veryslow]Downloading: https://dl.sandstorm.io/
$[veryslow]GPG signature is valid.
$[veryslow]Sandstorm started.
Visit this link to configure it:
  http://local.sandstorm.io:6080/admin/
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
