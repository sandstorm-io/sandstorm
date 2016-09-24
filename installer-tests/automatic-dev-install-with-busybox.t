Title: Ensure that installing with defaults succeeds with busybox mktemp/mkdir (here we run it as root)
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]sudo dpkg --configure -a && sudo apt-get -f -y install && echo dpkg-fixed
$[veryslow]dpkg-fixed
$[run]sudo DEBIAN_FRONTEND=noninteractive apt-get install -d -y --no-install-recommends busybox && echo busybox-downloaded
$[veryslow]busybox-downloaded
$[run]sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends busybox && echo busybox-installed
$[veryslow]busybox-installed
$[run]sudo mkdir -p /tmp/busybox-utilities && echo ok
$[slow]ok
$[run]sudo ln -sf $(which busybox) /tmp/busybox-utilities/mkdir && sudo ln -sf $(which busybox) /tmp/busybox-utilities/mktemp && sudo ln -sf $(which busybox) /tmp/busybox-utilities/stat && echo ok
$[slow]ok
$[run]sudo PATH=/tmp/busybox-utilities:$PATH:/sbin:/usr/sbin CURL_USER_AGENT=testing REPORT=no bash /vagrant/install.sh -d
$[slow]Sandstorm requires sysctl kernel.unprivileged_userns_clone to be enabled.
Config written to /opt/sandstorm/sandstorm.conf.
Finding latest build for dev channel...
$[veryslow]Downloading: https://dl.sandstorm.io/
$[veryslow]GPG signature is valid.
$[veryslow]Sandstorm started.
$[veryslow]Your server is coming online. Waiting up to 90 seconds...
$[veryslow]Visit this link to start using it:
  http://local.sandstorm.io:6080/
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
