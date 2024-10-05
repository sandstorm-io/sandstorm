FROM docker.io/ubuntu:20.04
RUN apt-get update &&\
    DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential libcap-dev xz-utils zip \
    unzip strace curl discount git python3 zlib1g-dev \
    cmake flex bison locales clang gcc-multilib && apt-get clean
RUN curl -L "https://go.dev/dl/go1.21.6.linux-amd64.tar.gz" -o go.tar.gz  \
    && tar -C /usr/local -xvf go.tar.gz \
    && rm go.tar.gz
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n -o ~/n \
    && bash ~/n v10 \
    && rm -rf ~/n
RUN https://nodejs.org/dist/v10.24.1/node-v10.24.1-headers.tar.gz -o node.tar.gz \
    && tar -xvf node.tar.gz \
    && mv node-v10.24.1/include/* /usr/include \
    && rm node.tar.gz \
    && rm -rf node-v10.24.1
RUN ln -s /usr/include/node /usr/local/include/node
ENV PATH "$PATH:/usr/local/go/bin:/usr/local/node/bin:/usr/local/node/include:/usr/local/node/include/node"
RUN useradd -m file-builder
WORKDIR /sandstorm