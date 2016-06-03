Title: Ensure that Sandstorm bails early on old kernels, with an error message
Vagrant-Box: precise64

$[run]CURL_USER_AGENT=testing REPORT=no /vagrant/install.sh
$[slow]Detected Linux kernel version:
*** INSTALLATION FAILED ***
Sorry, your kernel is too old to run Sandstorm.
You can report bugs at: http://github.com/sandstorm-io/sandstorm
$[exitcode]1
