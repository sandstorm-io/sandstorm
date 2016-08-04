Title: Ensure a dev-mode install works, escalating to root, and adding $USER (aka $SUDO_USER) to the sandstorm group
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]CURL_USER_AGENT=testing REPORT=no bash /vagrant/install.sh
$[slow]How are you going to use this Sandstorm install? [1]$[type]2
OK to continue? [yes]$[type]
$[slow]We're going to:
* Add you (vagrant) to the sandstorm group so you can read/write app data.
* Listen for inbound email on port 30025
Press enter to accept defaults. Type 'no' to customize. [yes]$[type]
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
$[run]for i in `seq 0 20`; do nc -z localhost 30025 && { echo yay; break; } || sleep 1 ; done
$[veryslow]yay
