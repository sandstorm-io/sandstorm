FROM docker.io/ubuntu:20.04
RUN apt-get -qq update && \
    DEBIAN_FRONTEND=noninteractive apt-get -qq install -y build-essential libcap-dev xz-utils zip \
    unzip strace curl discount git python3 zlib1g-dev \
    cmake flex bison locales clang gcc-multilib g++ jq && \
    rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/golang:1.21 /usr/local/go /usr/local/go
ENV PATH "$PATH:/usr/local/go/bin"
RUN groupadd -g 1000 file-builder
RUN useradd -m -g 1000 -u 1000 file-builder
RUN chown -R  file-builder:file-builder /usr/local
USER file-builder
RUN curl https://install.meteor.com/?release=2.3.5 | sh
USER root
RUN chown -R  root:root /usr/local
USER file-builder
ENV PATH $PATH:/home/file-builder/.meteor
ENV METEOR_WAREHOUSE_DIR /home/file-builder/.meteor
ENV USER file-builder
WORKDIR /sandstorm