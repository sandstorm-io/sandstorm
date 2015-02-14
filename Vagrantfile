# -*- mode: ruby -*-
# vi: set ft=ruby :

# Vagrantfile API/syntax version. Don't touch unless you know what you're doing!
VAGRANTFILE_API_VERSION = "2"

Vagrant.configure(VAGRANTFILE_API_VERSION) do |config|
  # We base ourselves off the trusty (Ubuntu 14.04) base box.
  config.vm.box = "trusty64"

  # The url from which to fetch that base box.
  config.vm.box_url = "https://cloud-images.ubuntu.com/vagrant/trusty/current/trusty-server-cloudimg-amd64-vagrant-disk1.box"

  # We forward port 6080, the Sandstorm web port, so that developers can
  # visit their sandstorm app from their browser as local.sandstorm.io:6080
  # (aka 127.0.0.1:6080).
  config.vm.network :forwarded_port, guest: 6080, host: 6080

  # Create a public network, which generally matched to bridged network.
  # Bridged networks make the machine appear as another physical device on
  # your network.
  config.vm.network :public_network

  # Use a shell script to "provision" the box. This install Sandstorm using
  # the bundled installer.
  config.vm.provision "shell",
    inline: "cd /vagrant && echo localhost > /etc/hostname && hostname localhost && sudo ./install.sh -d -e"

  # Make the vagrant user part of the sandstorm group so that commands like
  # `spk dev` work
  config.vm.provision "shell", inline: "usermod -a -G 'sandstorm' 'vagrant'"

end
