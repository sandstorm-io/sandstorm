# -*- mode: ruby -*-
# vi: set ft=ruby :

# Vagrantfile API/syntax version. Don't touch unless you know what you're doing!
VAGRANTFILE_API_VERSION = "2"

Vagrant.configure(VAGRANTFILE_API_VERSION) do |config|
  # We base ourselves off an official Debian base box.
  config.vm.box = "debian/bullseye64"

  # We forward port 6080, the Sandstorm web port, so that developers can
  # visit their sandstorm app from their browser as local.sandstorm.io:6080
  # (aka 127.0.0.1:6080).
  config.vm.network :forwarded_port, guest: 6080, host: 6080, host_ip: "127.0.0.1"

  # Create a link-local private address, so that the host can
  # use NFS with the Virtualbox guest. Virtualbox/Vagrant handles
  # network address translation so outbound network requests still
  # work.
  config.vm.provider :virtualbox do |vb, override|
    override.vm.network :private_network, ip: "192.254.254.2"
  end

  # Use a shell script to "provision" the box. This installs Sandstorm using
  # the bundled installer.
  config.vm.provision "shell", inline: <<-EOF
    set -e
    cd /vagrant
    echo localhost > /etc/hostname
    hostname localhost
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl gpg
    sudo OVERRIDE_DEFAULT_SERVER_USER=vagrant ./install.sh -d -e > /dev/null
    sudo usermod -a -G sandstorm vagrant
    sudo sed --in-place='' --expression='s/^BIND_IP=.*/BIND_IP=0.0.0.0/' /opt/sandstorm/sandstorm.conf
    sudo service sandstorm restart
    printf '\nYour server is online. It has the dev accounts feature enabled, so anyone can log in.'
    printf '\nDetails and customization instructions are available here:'
    printf '\n- https://github.com/sandstorm-io/sandstorm/wiki/Using-the-Vagrantfile'
    printf '\n'
    printf '\nVisit it at:'
    printf '\n  http://local.sandstorm.io:6080/'
    printf '\n'
EOF

  # Use NFS for the /vagrant shared directory, for performance and
  # compatibility.
  config.vm.synced_folder ".", "/vagrant", type: "nfs", nfs_udp: false

  # Calculate the number of CPUs and the amount of RAM the system has,
  # in a platform-dependent way; further logic below.
  cpus = nil
  total_kB_ram = nil

  host = RbConfig::CONFIG['host_os']
  if host =~ /darwin/
    cpus = `sysctl -n hw.ncpu`.to_i
    total_kB_ram =  `sysctl -n hw.memsize`.to_i / 1024
  elsif host =~ /linux/
    cpus = `nproc`.to_i
    total_kB_ram = `grep MemTotal /proc/meminfo | awk '{print $2}'`.to_i
  elsif host =~ /mingw/
    cpus = `powershell -Command "(Get-WmiObject Win32_Processor -Property NumberOfLogicalProcessors | Select-Object -Property NumberOfLogicalProcessors | Measure-Object NumberOfLogicalProcessors -Sum).Sum"`.to_i
    total_kB_ram = `powershell -Command "[math]::Round((Get-WmiObject -Class Win32_ComputerSystem).TotalPhysicalMemory)"`.to_i / 1024
  end

  # Use the same number of CPUs within Vagrant as the system, with 1
  # as a default.
  #
  # If we are unable to determine how much RAM the system has, use
  # 1GB. Otherwise, we aim to use 1/4 of the system RAM, with a
  # lower bound of 512MB and upper bound of 3GB. This is a compromise
  # between having the Vagrant guest operating system not run out of
  # RAM entirely (which it basically would if we went much lower than
  # 512MB) and also allowing it to use up a healthily large amount of
  # RAM so it can run faster on systems that can afford it.
  assign_cpus = nil
  assign_ram_mb = nil
  if cpus.nil? or cpus.zero?
    assign_cpus = 1
  else
    assign_cpus = cpus
  end
  if total_kB_ram.nil?
    assign_ram_mb = 1024
  else
    assign_ram_mb = (total_kB_ram / 1024 / 4)
    assign_ram_mb = [ 512, assign_ram_mb].max  # enforce lower bound
    assign_ram_mb = [3072, assign_ram_mb].min  # enforce upper bound
  end

  # Actually provide the computed CPUs/memory to the backing provider.
  config.vm.provider :virtualbox do |vb|
    vb.cpus = assign_cpus
    vb.memory = assign_ram_mb
  end
  config.vm.provider :libvirt do |libvirt|
    libvirt.cpus = assign_cpus
    libvirt.memory = assign_ram_mb
  end
end

### If you're on Windows, and you want to SMB share the
### /home/vagrant directory in the guest with your Windows
### machines, run "vagrant ssh" then do the following:
###
### sudo apt-get install samba pwgen
###
### Then sudo nano -w /etc/samba/smb.conf and make it contain the
### following, only remove the ### from the beginning of every line.
###
### [global]
### workgroup = WORKGROUP
### dns proxy = no
### bind interfaces only = no
### syslog only = yes
### syslog = 1
### server role = standalone server
### passdb backend = tdbsam
### obey pam restrictions = yes
### unix password sync = no
### pam password change = no
### map to guest = bad user
### usershare allow guests = no
###
### [vagranthome]
### comment = Vagrant home
### browseable = yes
### create mask = 0750
### directory mask = 0700
### read only = no
### valid users = vagrant
### path = /home/vagrant
###
### Then set a password for the vagrant user on Linux and enable it for
### samba use by running:
###
### pwgen -1  # generate a password
###
### sudo passwd vagrant
### sudo smbpasswd -a vagrant
###
### Then restart the VM via "vagrant reload" and visit
###
### \\169.254.254.2\vagranthome
###
### and log in with username vagrant (and password whatever
### you set above).
