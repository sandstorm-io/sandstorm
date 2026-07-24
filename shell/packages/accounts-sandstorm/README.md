# accounts-sandstorm for Meteor 3

This is Sandstorm's repository-local fork of
[`kenton:accounts-sandstorm`](https://github.com/sandstorm-io/meteor-accounts-sandstorm).
It preserves the package's public API while replacing its Fiber-based login
rendezvous and `meteor/http` usage with Meteor 3 async APIs and Fetch.

The fork was imported from upstream version 0.7.0 at commit
`7bf5f35d5b61f4a23b42950af78fd16dde524093`. Upstream copyright and the MIT
license are retained in `LICENSE`.
