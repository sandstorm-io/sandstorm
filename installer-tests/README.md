# Sandstorm installer tests

This directory contains code and tests used to test Sandstorm's
install script.  The tests are based on
[stodgy-tester](https://github.com/paulproteus/stodgy-tester).

A quick overview:

* The tests are in the `*.t` files in this directory.

* To run the test suite, do: `stodgy-tester --plugin=stodgy_tester.plugins.sandstorm_installer_tests`

* You can choose to run just one test by doing: `stodgy-tester that_file.t`

* Before you run any tests, you probably need to run `./prepare-for-tests.sh`.

You might consider this codebase a little over-wrought just to test a
shell script. If so, sorry about that.

# Goals

Some goals of this project:

* Create tests that verify that when we change install.sh, we don't
  break its behavior on a variety of operating systems and
  environments. (For example: Make sure Sandstorm can install on
  Debian.  Make sure the installer properly aborts with an error
  message on Arch Linux. Make sure Sandstorm can install within a
  Docker container.)

* Ensure we can run those tests automatically, periodically.

* Avoid adding misleading information to various logs that we examine
  to get a sense of how popular Sandstorm is.

# Technical details

## About the *.t language

The tests are written in a custom, semi-hacky domain-specific language
for running terminal programs and validating that the output of the
program is what we expect.

The test files contain a header and a body. Each contains different
directives.

## About the use of Vagrant

The `stodgy-tester` script uses Vagrant to manage a variety of
operating system images we can boot into. You can see the details in
`Vagrantfile` in this directory.

We Vagrant's `libvirt` backend, configured to use `qemu`, so that we
can run this on Sandstorm's Jenkins service (which is already
virtualized, so tools like VirtualBox can't easily run there). The
`libvirt` backend is not installed by default, so we make sure it is
available in `prepare-for-tests.sh`. To use this provider as the
default, we set an environment variable when invoking Vagrant.

Because we use the `libvirt` backend (with `qemu`), and because most
Vagrant boxes are distributed as VirtualBox images, we use
`vagrant-mutate` to convert them. That's a little tragic, but there
you go.

Since running the installer requires a copy of the Sandstorm
installer, we copy the contents of `../` (aka, the Sandstorm git
repository) into the VM using Vagrant's `rsync` "shared folders"
support.

## Test headers

The following are valid test headers.

* `Title`: The name of the test. Mostly unused, but hopefully keeps
  you sane when editing multiple tests. Arguably redundant with the
  filename; maybe I should remove it. (Specify exactly one per test.)

* `Vagrant-Box`: The name of a box, defined in _this directory's_
  `Vagrantfile`. Through careful choice of a `Vagrant-Box` value,
  you can. (Specify exactly one per test.)

* `Vagrant-Destroy-If-Bash`: A bash script that, if it exits with a
  true status code, causes `stodgy-tester` to destroy the Vagrant box
  in question, and re-create it, before running the test. This can
  prevent some tests from interfering with each other. Use this
  directive sparingly, as it is slow! (Specify zero or more per test.)

* `Vagrant-Precondition-Bash`: A bash script that, if it exits with a
  true status code, allows this test to run. If it exits with a false
  status code, `stodgy-tester` will skip the test and exit with a
  non-zero status code. (Specify zero or more per test.)

* `Postcondition`: A Python expression that must return `True` for the
  test to succeed. (Note: This appears to be totally unused, so this
  might go away soon.) (Specify zero or more per test.)

* `Vagrant-Postcondition`Bash`: A bash script that, if it exits with
  a true status code, allows the test to be considered a success. If
  it exits with a false status, it means the test failed. (Specify
  zero or more per test.)

The `stodgy-tester` program interprets test headers
case-insensitively. I like to write them in the capitalization style
above, since I'm so very used to email headers being capitalized like
that.

## Body directives

The following are valid body directives:

* `Some text`: This is the default directive; it means, expect this
  text to appear, waiting up to 1 second for it. It is OK if other text
  appears before this text.

* `$[slow]`: Wait longer than usual (by default, 30 sec) for this text
  to appear.

* `$[veryslow]`: Wait _even_ longer than usual (twice as long as
  `$[slow]`) for this text to appear.

* `$[run]`: Run a command, with future text assertions covering this
  particular program.

* `$[type]foo`: Provide `foo` to standard input of the program.

* `$[type]gensym`: `gensym` is a special-cased input sequence; instead
  of providng the string `gensym` to the program, we generate a
  (non-cryptographically-secure) random string of 10 alphanumeric
  characters. This way, we can type something different in every time
  the test runs, which is helpful for choosing a Sandcats subdomain name.

* `$[exitcode] n`: Verify that the command most recently run via
  `$[run]` has exited, and that it exited with the status code `n`
  (for example, `0`).

## Advanced hints about how to use body directives smartly

It's a smart idea to remove fragments of lines that might change over
time. For example, if a script prints `Today's date is 2015-06-04`,
you should only assert that it prints `Today's date is`. This is safe
since the default "Expect some text" directive will verify the initial
text, and skip right over the text after it.

It's a smart idea to remove lines that you don't care about. This is
safe since the default "Expect some text" directive is willing to skip
over things you didn't specify. (This does mean there currently is no
support for asserting some text does _not_ show up.)

To avoid filling the Sandstorm install logs with requests that come
from these tests, pass a `CURL_USER_AGENT=testing` environment
variable to `install.sh`. The install script will pass that through to
`curl`, and the Sandstorm stats code knows to ignore requests from
that come in with that `User-Agent` header.
