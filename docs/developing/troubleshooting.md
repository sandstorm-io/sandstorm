This page lists common problems and work-arounds.

This page needs expansion! If you encounter a new problem and solve it, feel free to add it here. If you encounter a problem you don't know how to solve, try asking on Stack Overflow, and be sure to add the "sandstorm.io" tag to your question. Or, talk to us on IRC (#sandstorm on freenode) or [sandstorm-dev](https://groups.google.com/group/sandstorm-dev).

Note that language-specific issues should be documented in the language-specific guide pages, namely:

* [Python](raw-python.md)
* [Ruby on Rails](raw-ruby-on-rails.md)
* [Pure client apps](https://github.com/sandstorm-io/sandstorm/wiki/Pure-client-apps)

## KeyError: 'getpwuid(): uid not found: 1000'

This is a Python bug. See [the Python packaging guide](raw-python.md#keyerror-getpwuid-uid-not-found-1000) for a work-around.

## `EROFS` or "Read-only filesystem"

Only the `/var` directory is writable; the rest of the filesystem (which contains the contents of your app package) is read-only.

If your app wants to write to locations other than `/var`, and it's not easy to change the app's code, one work-around is to create a symlink from the location you app wants to modify to a location under `/var`.  This won't work for all applications however.