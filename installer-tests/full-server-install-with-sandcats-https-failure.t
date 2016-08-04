Vagrant-Box: jessie
Precondition: sandstorm_not_installed
Cleanup: uninstall_sandstorm

$[run]sudo cat /proc/sys/kernel/unprivileged_userns_clone
$[slow]0
$[run]read line ; echo $line > /tmp/sandcats-domain-name ; echo ok
$[type]gensym
$[slow]ok
$[run]echo insecureExampleAdminToken > /tmp/admin-token ; echo ok
$[slow]ok
$[run]curl -k https://sandcats-dev-machine.sandstorm.io/reserve --data 'email=sandstorm-test-suite@asheesh.org&rawHostname='$(</tmp/sandcats-domain-name) > /tmp/json; echo ok
$[slow]ok
$[run]cat /tmp/json| sed -r 's/.*.token.:.([a-zA-Z0-9]*).*/\1/' > /tmp/domain-reservation-token ; echo ok
$[slow]ok
$[run]sudo OVERRIDE_SANDCATS_GETCERTIFICATE_API_PATH=generate500 ADMIN_TOKEN=$(</tmp/admin-token) CHOSEN_INSTALL_MODE=1 SANDCATS_DOMAIN_RESERVATION_TOKEN=$(</tmp/domain-reservation-token) DESIRED_SANDCATS_NAME=$(</tmp/sandcats-domain-name) CURL_USER_AGENT=testing REPORT=no OVERRIDE_SANDCATS_BASE_DOMAIN=sandcats-dev.sandstorm.io OVERRIDE_SANDCATS_API_BASE=https://sandcats-dev-machine.sandstorm.io OVERRIDE_SANDCATS_CURL_PARAMS=-k bash /vagrant/install.sh -d -p 80
$[slow]As a Sandstorm user, you are invited to use a free Internet hostname as a subdomain of sandcats.io
$[veryslow]Registering your pre-reserved domain
$[slow]Congratulations! We have registered your
Your credentials to use it are in /opt/sandstorm/var/sandcats; consider making a backup.
$[slow]Now we're going to auto-configure HTTPS for your server.
$[veryslow]Requesting certificate
$[veryslow]Downloading: https://dl.sandstorm.io
$[veryslow]GPG signature is valid.
$[veryslow]Sandstorm started. PID =
$[veryslow]Visit this link to start using it:
  http://
To learn how to control the server, run:
  sandstorm help
$[exitcode]0
$[run]sudo -u sandstorm cat /opt/sandstorm/var/sandstorm/adminToken; echo
$[slow]insecureExampleAdminToken
$[run]for i in `seq 0 20`; do nc -z localhost 80 && { echo yay; break; } || sleep 1 ; done
$[slow]yay
