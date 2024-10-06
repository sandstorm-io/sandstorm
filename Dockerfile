FROM docker.io/ubuntu:20.04
RUN apt-get -qq update && \
    DEBIAN_FRONTEND=noninteractive apt-get -qq install -y build-essential libcap-dev xz-utils zip \
    unzip strace curl discount git python3 zlib1g-dev \
    cmake flex bison locales clang gcc-multilib g++ jq xz-utils && \
    rm -rf /var/lib/apt/lists/*
RUN curl -L "https://go.dev/dl/go1.21.6.linux-amd64.tar.gz" -o go.tar.gz  \
    && tar -C /usr/local -xf go.tar.gz \
    && rm go.tar.gz
ENV PATH "$PATH:/usr/local/go/bin"
RUN groupadd -g 1000 file-builder
RUN useradd -m -g 1000 -u 1000 file-builder


# https://github.com/meteor/galaxy-images/blob/b25048a24df72022b738fc7eefae2fa29fd45a21/meteor-base/Dockerfile
ENV NODE_VERSION="14.21.4" 
ENV NODE_URL="https://static.meteor.com/dev-bundle-node-os/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"
ENV DIR_NODE="/usr/local"

WORKDIR /home/file-builder


RUN curl -sSL "$NODE_URL" | tar -xz -C /usr/local/ && mv $DIR_NODE/node-v${NODE_VERSION}-linux-x64 $DIR_NODE/v$NODE_VERSION

# add node and npm to path so the commands are available
ENV NODE_PATH $DIR_NODE/v$NODE_VERSION/lib/node_modules
ENV PATH $DIR_NODE/v$NODE_VERSION/bin:$PATH

RUN chown -R file-builder:file-builder /usr/local/ /home/file-builder

USER file-builder

RUN npm install -g meteor@2.3.5

WORKDIR /sandstorm