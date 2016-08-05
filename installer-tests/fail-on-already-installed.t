Title: Ensure that if Sandstorm is already installed, we print an error
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]sudo mkdir -p /opt/sandstorm && ok
$[slow]ok
$[run]sudo CURL_USER_AGENT=testing REPORT=no /vagrant/install.sh -d
$[veryslow]This script is trying to install to /opt/sandstorm.
$[exitcode]1
