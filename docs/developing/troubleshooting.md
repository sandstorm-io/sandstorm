This page lists common problems and work-arounds.

This page needs expansion! If you encounter a new problem and solve it, feel free to add it here. If you encounter a problem you don't know how to solve, try asking on Stack Overflow, and be sure to add the "sandstorm.io" tag to your question. Or, talk to us on IRC (#sandstorm on freenode) or [sandstorm-dev](https://groups.google.com/group/sandstorm-dev).

Note that language-specific issues should be documented in the language-specific guide pages, namely:

* [Python](raw-python.md)
* [Ruby on Rails](raw-ruby-on-rails.md)
* [Pure client apps](https://github.com/sandstorm-io/sandstorm/wiki/Pure-client-apps)

## Clicking a link in the app does not open the link

Sandstorm apps cannot navigate the user away from the app. Therefore, app
authors should set `target="_blank"` on links within the app.

A convenient way to do this automatically for all links in the page is to add
the following HTML to your document's `<head>`:

```html
<base target="_blank">
```

## KeyError: 'getpwuid(): uid not found: 1000'

This is a Python bug. See [the Python packaging guide](raw-python.md#keyerror-getpwuid-uid-not-found-1000) for a work-around.

## `EROFS` or "Read-only filesystem"

Only the `/var` directory is writable; the rest of the filesystem (which contains the contents of your app package) is read-only.

If your app wants to write to locations other than `/var`, and it's not easy to change the app's code, one work-around is to create a symlink from the location you app wants to modify to a location under `/var`.  This won't work for all applications however.