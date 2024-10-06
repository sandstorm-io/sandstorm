FROM docker.io/ubuntu:20.04
RUN apt-get -qq update &&\
    DEBIAN_FRONTEND=noninteractive apt-get -qq install -y build-essential libcap-dev xz-utils zip \
    unzip strace curl discount git python3 zlib1g-dev \
    cmake flex bison locales clang gcc-multilib g++ && apt-get -q -q clean
RUN curl -L "https://go.dev/dl/go1.21.6.linux-amd64.tar.gz" -o go.tar.gz  \
    && tar -C /usr/local -xf go.tar.gz \
    && rm go.tar.gz
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n -o ~/n \
    && bash ~/n v10 \
    && rm -rf ~/n
RUN ln -s /usr/include/node /usr/local/include/node
ENV PATH "$PATH:/usr/local/go/bin:/usr/local/node/bin:/usr/local/node/include:/usr/local/node/include/node"
RUN groupadd -g 1000 file-builder
RUN useradd -m -g 1000 -u 1000 file-builder
USER file-builder
WORKDIR /sandstorm