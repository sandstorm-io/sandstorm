# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# This Dockerfile is for general Sandstorm usage. It will fetch the latest binary distrubition of
# Sandstorm and install it inside the container. You can build this image with `make .docker` or
# `docker build -t sandstorm .`.
#
# You can then run the docker container with:
# docker run -p 6080:6080 -i -t sandstorm
# Give it 5-10 seconds, and then Sandstorm should be available at
# http://local.sandstorm.io:6080/
#
# Keep in mind that all data will be local to the container. If you want to
# store Sandstorm's data outside the container, then run the following:
# mkdir -p sandstorm_var/{log,mongo,pid,sandstorm/apps,sandstorm/grains,sandstorm/downloads} && chmod -R 777 sandstorm_var
# docker run -v `pwd`/sandstorm_var:/home/sandstorm/sandstorm/var -p 6080:6080 -i -t sandstorm

# Use Ubuntu Trusty as our base
FROM ubuntu:14.04

# Install sandstorm dependencies
RUN apt-get update
RUN apt-get install -y curl xz-utils

RUN adduser --disabled-password --gecos "" sandstorm
USER sandstorm
ENV HOME /home/sandstorm
ENV USER sandstorm

ADD ./install.sh /install.sh

RUN /install.sh -d -u

RUN echo 'SERVER_USER=sandstorm\n\
PORT=6080\n\
MONGO_PORT=6081\n\
BIND_IP=0.0.0.0\n\
BASE_URL=http://local.sandstorm.io:6080\n\
WILDCARD_HOST=*.local.sandstorm.io:6080\n\
MAIL_URL=\n' > $HOME/sandstorm/sandstorm.conf

RUN echo 'export PATH=$PATH:$HOME/sandstorm' >> $HOME/.bashrc

EXPOSE 6080
CMD /home/sandstorm/sandstorm/sandstorm start && sleep infinity
