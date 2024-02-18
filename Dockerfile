FROM docker.io/ubuntu:20.04
WORKDIR /sandstorm
RUN apt-get update &&\
    DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential libcap-dev xz-utils zip \
    unzip strace curl discount git python3 zlib1g-dev \
    cmake flex bison locales clang gcc-multilib
RUN git config --system --add safe.directory /sandstorm
RUN curl -L "https://go.dev/dl/go1.21.6.linux-amd64.tar.gz" -o go.tar.gz  \
    && tar -C /usr/local -xvf go.tar.gz \
    && rm go.tar.gz
RUN curl -L "https://nodejs.org/dist/v10.24.1/node-v10.24.1-linux-x64.tar.gz" -o node.tar.gz \
    && tar -C /usr/local -xvf node.tar.gz \
    && rm node.tar.gz
RUN curl https://install.meteor.com/ | sh
ENV PATH "$PATH:/usr/local/go/bin:/usr/local/node/bin"
RUN chown -R root:root /usr/local/node-v10.24.1-linux-x64
RUN ln -s /usr/local/node-v10.24.1-linux-x64 /usr/local/node
CMD  "/bin/sh"