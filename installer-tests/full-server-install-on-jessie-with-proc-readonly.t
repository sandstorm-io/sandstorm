Title: Ensure Sandstorm installer shows an error if /proc/sys is mounted read-only
Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]sudo mkdir -p /tmp/read-only-proc ; echo done
$[slow]done
$[run]sudo umount /tmp/read-only/proc || true; echo done
$[slow]done
$[run]sudo mount -o ro -t proc none /tmp/read-only-proc; echo done
$[slow]done
$[run]sudo mount --bind -o ro /tmp/read-only-proc/sys /proc/sys; echo done
$[slow]done
$[run]CURL_USER_AGENT=testing REPORT=no OVERRIDE_SANDCATS_BASE_DOMAIN=sandcats-dev.sandstorm.io OVERRIDE_SANDCATS_API_BASE=https://sandcats-dev-machine.sandstorm.io OVERRIDE_SANDCATS_CURL_PARAMS=-k bash /vagrant/install.sh -i
$[slow]You are using a Debian-derived Linux kernel, which needs a configuration option
