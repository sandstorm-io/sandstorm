Title: Auto-install with root on Debian jessie, in dev mode
Vagrant-Box: jessie
Vagrant-Precondition-bash: ! -d $HOME/sandstorm
Vagrant-Precondition-bash: ! -d /opt/sandstorm
Cleanup: uninstall_sandstorm(parsed_headers['vagrant-box'])

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]sudo CURL_USER_AGENT=testing bash /vagrant/install.sh -d
$[slow]Sandstorm requires sysctl kernel.unprivileged_userns_clone to be enabled.
Config written to /opt/sandstorm/sandstorm.conf.
Finding latest build for dev channel...
$[veryslow]Downloading: https://dl.sandstorm.io/
$[veryslow]Sandstorm started.
Visit this link to configure it:
  http://local.sandstorm.io:6080/admin/
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
