FROM docker.io/ubuntu:20.04
RUN apt-get update -q -q &&\
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q -q build-essential libcap-dev xz-utils zip \
    unzip strace curl discount git python3 zlib1g-dev \
    libnode-dev libcapnp-dev g++ \
    cmake flex bison locales clang gcc-multilib && apt-get -q -q clean
RUN curl -L "https://go.dev/dl/go1.21.6.linux-amd64.tar.gz" -o go.tar.gz  \
    && tar -C /usr/local -xf go.tar.gz \
    && rm go.tar.gz
# RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n -o ~/n \
#     && bash ~/n v10 \
#     && rm -rf ~/n
# RUN ln -s /usr/local/n/versions/node/10.24.1/include /usr/local/include/node
# ENV PATH "$PATH:/usr/local/go/bin:/usr/local/node/bin:/usr/local/node/include:/usr/local/node/include/node:/usr/local/n/versions/node/10.24.1:/usr/local/n/versions/node/10.24.1/include"
RUN useradd -m file-builder


USER file-builder
WORKDIR /home/file-builder
ENV N_PREFIX /home/file-builder/n
ENV NODE_VERSION 14.17.6
# ENV NODE_PATH $NVM_DIR/v$NODE_VERSION/lib/node_modules
ENV PATH      /home/file-builder/n/bin:/home/file-builder/.meteor:$PATH
# Install nvm with node and npm
ENV PREFIX /home/file-builder/n
RUN curl -L https://bit.ly/n-install | bash -s -- -n -y $NODE_VERSION 
WORKDIR /sandstorm