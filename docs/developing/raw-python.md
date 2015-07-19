# Python and raw Sandstorm

If you're interested in integrating Python with raw Sandstorm APIs and
generating SPK files by hand, here is a brief collection of information
you will need to know.

**Note**: This highly-technical documentation explains the inner
workings of Python on Sandstorm. If you want to package a Python web
app for Sandstorm, and would like a well-tested and well-documented
way to do that, read the [five minute vagrant-spk packaging
tutorial](../vagrant-spk/packaging-tutorial.md) instead!

## Integrating with raw Sandstorm APIs

To use raw Sandstorm Cap'n Proto APIs, you can use
[pycapnp](https://jparyani.github.io/pycapnp/).

## Packaging gotchas

### KeyError: 'getpwuid(): uid not found: 1000'

Due to a [bug in Python](http://bugs.python.org/issue10496), an exception will be thrown at startup if Python can't determine the current uid's home directory. In general, the concept of a "home directory" does not make sense in Sandstorm.

This can be worked around by defining the `HOME` environment variable in `sandstorm-pkgdef.capnp`. Look for the `environ` field and add `HOME` to it like so:

    environ = [
        # Note that this defines the *entire* environment seen by your app.
        (key = "PATH", value = "/usr/local/bin:/usr/bin:/bin"),
        (key = "HOME", value = "/var")
      ]
