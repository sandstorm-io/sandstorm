#! /bin/bash

# Builds and installs Sandstorm from source on Ubuntu Trusty Tahr.

set -e

sudo apt-get update
sudo apt-get install git libcap-dev xz-utils imagemagick clang-3.5 zip

sudo ln -s /usr/bin/clang-3.5 /usr/bin/clang
sudo ln -s /usr/bin/clang++-3.5 /usr/bin/clang

# Install Meteor
curl https://install.meteor.com/ | sh

# Build and install Sandstorm
make
make install
