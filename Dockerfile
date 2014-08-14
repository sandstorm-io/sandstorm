# Use Ubuntu Trusty as our base
FROM ubuntu:14.04

# Install sandstorm dependencies
RUN apt-get update
RUN apt-get install -y xz-utils

RUN adduser --disabled-password --gecos "" sandstorm
USER sandstorm
ENV HOME /home/sandstorm
ENV USER sandstorm

ADD ./install.sh /install.sh
COPY ./sandstorm-0.tar.xz /sandstorm-0.tar.xz

RUN /install.sh -d -u /sandstorm-0.tar.xz

RUN echo 'SERVER_USER=sandstorm\n\
PORT=6080\n\
MONGO_PORT=6081\n\
BIND_IP=0.0.0.0\n\
BASE_URL=http://localhost:6080\n\
WILDCARD_HOST=*.local.sandstorm.io:6080\n\
ALLOW_DEMO_ACCOUNTS=true\n\
MAIL_URL=\n' > $HOME/sandstorm/sandstorm.conf

RUN echo 'export PATH=$PATH:$HOME/sandstorm' >> $HOME/.bashrc

EXPOSE 6080
CMD /home/sandstorm/sandstorm/sandstorm start && sleep infinity
# Now you can build the container with `docker build -t sandstorm .` and run the docker container with `docker run -p 6080:6080 -i -t sandstorm`
