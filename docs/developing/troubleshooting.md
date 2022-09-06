This page lists common problems and work-arounds.

This page needs expansion! If you encounter a new problem and solve it, feel
free to add it here. If you encounter a problem you don't know how to solve,
try asking on Stack Overflow, and be sure to add the "sandstorm.io" tag to your
question. Or, talk to us on IRC (#sandstorm on libera.chat) or
[sandstorm-dev](https://groups.google.com/group/sandstorm-dev).

Note that language-specific issues should be documented in the
language-specific guide pages, namely:

* [Python](raw-python.md)
* [Ruby on Rails](raw-ruby-on-rails.md)
* [Pure client apps](raw-pure-client-apps.md)

## Getting a shell in the context of the grain

`vagrant-spk enter-grain` allows you to run a shell (e.g. `bash`) in the context of a grain. This can
illuminate why an app is behaving in a particular way. For details and limitations, read [the
docs about the `vagrant-spk enter-grain` command](debugging.md).

## Clicking a link in the app does not open the link

Sandstorm apps cannot navigate the user away from the app. Therefore, app
authors should set `target="_blank"` on links within the app.

A convenient way to do this automatically for all links in the page is to add
the following HTML to your document's `<head>`:

```html
<base target="_blank">
```

## A blank white screen renders where the app should be

This can happen when a Sandstorm app in development doesn't know its
correct base URL and serves a HTTP redirect away from the Sandstorm
server. Sandstorm blocks that redirect, resulting in a white grain
frame.

To find out if you're running into this issue, open the Javascript
console in your browser and look for a `Content-Security-Policy`
violation. If you see a message about navigation being blocked, then
very likely you are seeing this error.

If possible, configure the app to use a base URL of `''`, literally
the empty string. Then it will send HTTP redirects without
specifying a base URL. If that isn't possible, Sandstorm apps should
look at the `Host:` header for a base URL.

## KeyError: 'getpwuid(): uid not found: 1000'

This is a Python bug. See
[the Python packaging guide](raw-python.md#keyerror-getpwuid-uid-not-found-1000)
for a work-around.

## `EROFS` or "Read-only filesystem"

Only the `/var` directory is writable; the rest of the filesystem (which
contains the contents of your app package) is read-only.

If your app wants to write to locations other than `/var`, and it's not easy to
change the app's code, one work-around is to create a symlink from the location
you app wants to modify to a location under `/var`.  This won't work for all
applications however.

## ETag data

Web apps often use the `ETag` HTTP response header to control caching. In Sandstorm, this header is
permitted so long as it follows the HTTP specification's requirement that the header values are
formatted with double-quote marks, like: `ETag: "value"` or `ETag: W/"value"`.

Some apps use strings without quotation marks in their ETag headers, such as `ETag: value`, which
violates the HTTP standard.  Sandstorm does not permit invalid header values because ambiguity can
lead to security problems. Therefore, Sandstorm will drop invalid `ETag` headers and will write a
warning to the grain's debug log. Usually, this does not affect app functionality, other than to
reduce the effectiveness of the browser's cache.

HTTP headers are processed within the grain at the [sandstorm-http-bridge](../using/how-it-works.md)
layer. Recent versions of `sandstorm-http-bridge` drop the header and log a message. In versions
v0.177 and earlier of `sandstorm-http-bridge`, invalid ETag data would trigger an exception,
causing the request to fail.

## SPK is missing files, but app works in dev mode

Sandstorm packages, when "packed" into an SPK file, must contain all files needed by the app. Those
files are typically specified in `.sandstorm/sandstorm-files.list` and detected when the app runs in
dev mode. Further files can be specified via an `alwaysInclude` directive in
`.sandstorm/sandstorm-pkgdef.capnp`. Some apps hard-code all files in
`.sandstorm/sandstorm-files.list` rather than relying on auto-detection. In any event, if the app
needs a file that is missing in the Sandstorm package, the file must be added.

Note that paths begin without a slash character. For example, to include `/path/to/include`, one
types `path/to/include` into the `alwaysInclude` line or the `sandstorm-files.list` file.

**How to identify this error:** Sometimes the app will crash (HTTP response code 500 Server Error)
if it is affected by this problem. Often a "No such file" or "No such module" error appears in the
grain log, similar to the following.

```
Warning: require_once(path/to/file.php): failed to open stream: No such file or directory
```

or

```
ImportError: No such module requests
```

**How to fix the problem:** Our recommendations are as follows.

- For Python apps, **add the app's virtualenv to alwaysInclude.** To do that, look for the
  `alwaysInclude` list and add `opt/app-venv`. See the [ContactOtter sandstorm-pkgdef.capnp for an
  example.](https://github.com/phildini/logtacts/blob/27ac05f88896778baf5da155afa6c733d3d6a264/.sandstorm/sandstorm-pkgdef.capnp#L137)
  It is sometimes helpful to also add `usr/lib/python3.9` (or the corresponding path for your
  version of Python).

- For nodejs apps, **add node_modules to alwaysInclude.** See the [Duolodo sandstorm-pkgdef.capnp
  for an
  example.](https://github.com/dwrensha/duoludo/blob/34e0eae7522c867899087f91d577fadf4246c915/.sandstorm/sandstorm-pkgdef.capnp#L84)

- For PHP apps, consider adding **all of /opt/app to alwaysInclude.** See the [MediaWiki
  sandstorm-pkgdef.capnp for an
  example.](https://github.com/jparyani/mediawiki-sandstorm/blob/f636a14794fa5d6c789d48ce32b51db342ca9d83/.sandstorm/sandstorm-pkgdef.capnp#L96)

- For Ruby apps that use bundler, **add the bundle to alwaysInclude.** See the [lobste.rs
  sandstom-pkgdef.capnp for an
  example.](https://github.com/dwrensha/lobsters-sandstorm/blob/6cb92e89779c8566c48dbb62669fc1b05d7effcf/sandstorm-pkgdef.capnp#L48)

- For apps that rely on system libraries, consider using `alwaysInclude` to add more system paths to
  be snapshotted into the package.

**How file auto-detection works.** At each launch of `spk dev` (equivalently, each launch of
`vagrant-spk dev`), a FUSE filesystem is created that watches all filesystem operations by the
app. When the `spk dev` session terminates, any files that the app `open()`d are logged into
`.sandstorm/sandstorm-files.list`. This skips any files that are merely `stat()`d. Because some apps
know their full list of dependencies, the `.sandstorm/sandstorm-pkgdef.capnp` file is **not**
written if the `alwaysInclude` line contains `"."`, which has the meaning of "include all files that
the app can see." The `meteor` platform stack takes advantage of this feature.
