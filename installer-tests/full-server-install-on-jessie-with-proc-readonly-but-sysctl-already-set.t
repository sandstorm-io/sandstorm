Title: Ensure Sandstorm installer succeeds even if /proc/sys is mounted read-only so long as userns works on Debian
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]echo 1 | sudo dd of=/proc/sys/kernel/unprivileged_userns_clone ; echo ok
$[slow]ok
$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]1
$[run]sudo mkdir -p /tmp/read-only-proc && echo ok
$[slow]ok
$[run]sudo umount /tmp/read-only-proc || true && echo ok
$[slow]ok
$[run]sudo mount -o ro -t proc none /tmp/read-only-proc && echo ok
$[slow]ok
$[run]sudo mount --bind -o ro /tmp/read-only-proc/sys /proc/sys && echo ok
$[slow]ok
$[run]sudo CURL_USER_AGENT=testing REPORT=no bash /vagrant/install.sh -d
$[slow]Config written to /opt/sandstorm/sandstorm.conf.
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
