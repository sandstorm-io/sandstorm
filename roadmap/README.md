# Sandstorm Technology Roadmap

This directory describes all of the technology built or being built by the Sandstorm project.

Throughout this roadmap, you'll find "TODO" entries. There are three kinds of TODOs:

* project: A large project, requiring significant design, implementing new independent functionality.
* feature: A smaller feature augmenting existing functionality.
* roadmap: Missing bits of the roadmap itself.

## [Sandstorm Platform](platform)

Features of the core Sandstorm platform. Specifically, this includes things that:

* The user directly interacts with (as opposed to logistical details that only app developers deal with).
* Are not specific to any particular hosting strategy (self-hosted, managed, blackrock, etc.).

## [Blackrock](blackrock)

Blackrock, the cluster management technology underlying managed hosting and our eventual enterprise product.

## [Self-hosting](self-hosting)

Improving the Sandstorm self-hosting experience.

## Containers

_TODO(roadmap): Write this section._

The Sandstorm containerization technology. This includes logistical features that may be relevant to app developers but which are invisible to the end user.

## Drivers

_TODO(roadmap): Write this section._

Drivers extend Sandstorm with the ability to speak common web protocols, like IMAP or IRC. Some drivers are "pseudo-drivers", meaning they are implemented by the Sandstorm shell, while other drivers are implemented as apps.

## Developer Tools

_TODO(roadmap): Write this section._

Sandstorm's developer tools are used to build app packages.

## Cap'n Proto

_TODO(roadmap): Write this section._

Cap'n Proto is Sandstorm's underlying communications protocol.

See also: https://capnproto.org

## App Store

_TODO(roadmap): Write this section._

Sandstorm operates a marketplace for Sandstorm apps which any Sandstorm server can interact with.

## Tests

_TODO(roadmap): Write this section._

Sandstorm's automated testing framework (for testing Sandstorm itself).
