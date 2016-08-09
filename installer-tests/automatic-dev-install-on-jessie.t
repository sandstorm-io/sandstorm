Title: Ensure that installing with defaults succeeds (here we run it as root)
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]sudo CURL_USER_AGENT=testing REPORT=no bash /vagrant/install.sh -d
$[slow]Sandstorm requires sysctl kernel.unprivileged_userns_clone to be enabled.
Config written to /opt/sandstorm/sandstorm.conf.
Finding latest build for dev channel...
$[veryslow]Downloading: https://dl.sandstorm.io/
$[veryslow]GPG signature is valid.
$[veryslow]Sandstorm started.
Visit this link to start using it:
  http://local.sandstorm.io:6080/
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
