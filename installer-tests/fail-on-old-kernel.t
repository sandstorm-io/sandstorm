Title: Can't install Sandstorm on old kernels
Vagrant-Box: precise64
Vagrant-Precondition-bash: ! -d $HOME/sandstorm
Vagrant-Precondition-bash: ! -d /opt/sandstorm
Vagrant-Postcondition-bash: ! -d $HOME/sandstorm
Vagrant-Postcondition-bash: ! -d /opt/sandstorm

$[run]CURL_USER_AGENT=testing /vagrant/install.sh
$[slow]Detected Linux kernel version:
Sorry, your kernel is too old to run Sandstorm.
*** INSTALLATION FAILED ***
Report bugs at: http://github.com/sandstorm-io/sandstorm
$[exitcode]1
