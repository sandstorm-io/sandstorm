Title: Ensure install.sh bails out early if user wants a typical install but refuses to let installer escalate to root
Vagrant-Box: trusty64
Precondition: sandstorm_not_installed
Vagrant-Postcondition-bash: ! -d $HOME/sandstorm
Vagrant-Postcondition-bash: ! -d /opt/sandstorm

$[run]CURL_USER_AGENT=testing REPORT=no /vagrant/install.sh
$[slow]Sandstorm makes it easy to run web apps on your own server. You can have:

1. A typical install, to use Sandstorm (press enter to accept this default)
2. A development server, for working on Sandstorm itself or localhost-based app development

How are you going to use this Sandstorm install? [1] $[type]2
If you want app developer mode for a Sandstorm install, you need root
due to limitations in the Linux kernel.

To set up Sandstorm, we will use sudo to switch to root, then
provide further information before doing the install.
Sandstorm's database and web interface won't run as root.
OK to continue? [yes] $[type]no

One development feature does require root. To install anyway, run:

install.sh -u

to install without using root access. In that case, Sandstorm will operate OK
but package tracing ('spk dev') will not work.

You can report bugs at: http://github.com/sandstorm-io/sandstorm
$[exitcode]1
