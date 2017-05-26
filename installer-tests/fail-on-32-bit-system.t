Title: Ensure that Sandstorm installer bails early on 32-bit machines with an error message
Vagrant-Box: debian-7.8-32-nocm

$[run]CURL_USER_AGENT=testing REPORT=no /vagrant/install.sh
$[slow]*** INSTALLATION FAILED ***
Sorry, the Sandstorm server currently only runs on x86_64 machines.
You can report bugs at: http://github.com/sandstorm-io/sandstorm
$[exitcode]1
