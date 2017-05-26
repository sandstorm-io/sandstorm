# Raw integration guide for Ruby on Rails apps on Sandstorm

**Note**: This highly-technical documentation explains the inner
workings of Ruby on Rails on Sandstorm. If you want to package a Rails
app for Sandstorm, consider reading the [five minute vagrant-spk
packaging tutorial](../vagrant-spk/packaging-tutorial.md) instead, and
using the [DIY stack](../vagrant-spk/platform-stacks.md#diy-platform-stack).

## Introduction

This guide collects some wisdom
gained from working on Sandstorm ports of
[GitLab](https://github.com/dwrensha/gitlab-sandstorm)
and [Lobsters](https://github.com/dwrensha/lobsters-sandstorm).
If you want to see the concrete details
in action, you should explore those repositories.
In fact, cloning
[lobsters-sandstorm](https://github.com/dwrensha/lobsters-sandstorm)
would probably give you a decent good starting point
for doing your own app port.

This guide assumes that you are familiar with the basics of raw
packaging of Sandstorm apps, as outlined in the [raw packaging
guide](raw-packaging-guide.md).

Some of the information here might also be useful for
porting non-Rails Ruby apps.


## Ruby installation

We want to install Ruby in such a way that:

  1. We have precise control over which version is installed.
  2. The installation path is the same on our development system as it will be in the packaged app.
     (Ruby installations tend not to deal well with getting relocated.)
  3. We don't need to include our home directory in the packaged app.


We can satisfy these constraints by installing either
[RBenv](https://github.com/sstephenson/rbenv)
or [RVM](https://rvm.io/) in `/usr/local`.

### RBenv / Ruby-Build

RBenv can be installed following steps like these:

```
$ sudo git clone https://github.com/sstephenson/rbenv.git /usr/local/rbenv
$ sudo git clone https://github.com/sstephenson/ruby-build.git /usr/local/rbenv/plugins/ruby-build
$ sudo groupadd rbenv
$ sudo usermod -a -G rbenv `whoami`
$ sudo chgrp -R rbenv /usr/local/rbenv
$ sudo chmod -R g=rwx /usr/local/rbenv
```

To activate it, you'll need to add this to your `~/.bashrc`:

```
export RBENV_ROOT=/usr/local/rbenv
export PATH="$RBENV_ROOT/bin:$PATH"
eval "$(rbenv init -)"
```

Now install the ruby needed by your app. For example,

```
$ rbenv install 2.1.5
```


### RVM

RVM should work too, but we haven't tested it.

Note that relative RPATHs currently
[don't work on Sandstorm](https://groups.google.com/forum/#!topic/sandstorm-dev/0IDiUgSihiI),
which means that you won't be able to use RVM's binary Ruby distributions.
You can work around this by making sure
to build Ruby from source, e.g.
```
$ rvm install 2.1.5 --disable-binary
```

## Project Setup

### Directory Structure

To cleanly separate concerns,
we recommend that you start a new Git repository
that brings in the original project as a subdirectory.
For example, in our Lobsters port,
we created a [new repo](https://github.com/dwrensha/lobsters-sandstorm)
called "lobsters-sandstorm",
containing a [Makefile](https://github.com/dwrensha/lobsters-sandstorm/blob/master/Makefile)
with a recipe that `git clone`s our
[fork of the original Lobsters repo](https://github.com/dwrensha/lobsters).

### Symlinks

Rails projects have a standard directory structure,
with subdirectories including `app/`, `config/`, `public/`,
and others.
Of these, `tmp/` and `log/` are notable
in that they need to be writable at run time.
To allow these to function in a packaged Sandstorm
app, you'll need to add them as symlinks, e.g.:

```
$ ln -s /tmp tmp
$ ln -s /var/log log
```

Note that the `/tmp` directory mounted for apps
has a limited capacity, currently 16MB per
app instance.

### Database Configuration

ActiveRecord conveniently allows us to use SQLite,
which, for Sandstorm apps, is usually a much better fit
than MySQL and PostgreSQL.
To use it, make sure that your `Gemfile` includes
the "sqlite3" gem, and make sure
your `config/database.yml` looks something like:

```
production:
  adapter: sqlite3
  pool: 5
  timeout: 5000
  database: /var/sqlite3/db.sqlite3
```

It might also make sense to
include an initialized database
as part of the packaged app,
so that your start script
can just copy it over to writable storage
when the app first boots.

### gems

Make sure you have Bundler installed:

```
$ gem install bundler
```

Now you can install your project's dependencies.
It's best to put them in a local directory, like this:

```
$ bundle install --path .bundle --without test development
```


### Ruby PATH

In your app, it's best to avoid the
fancy shell setup code that RVM and RBenv
typically rely on. Instead, you should
directly use whatever Ruby binary you need.
For example, if you are using RBenv and Ruby 2.1.5, this would
entail adding `/usr/local/rbenv/versions/2.1.5/bin` to your `PATH`.

### Session Secret

To freshly generate a new secret on each
startup of the app, and pass it in through an environment variable,
make sure that you have a `config/secrets.yml` like this:

```
production:
  secret_key_base: <%= ENV["SECRET_KEY_BASE"] %>
```

and that you add a line like this to your startup scripts:

```
export SECRET_KEY_BASE=`base64 /dev/urandom | head -c 30`
```


### Precompile Assets

Make sure that your `config/environments/production.rb` is configured like this:

```ruby
config.serve_static_assets = true # serve the precompiled assets
config.assets.compile = false     # don't try to compile assets on the fly

config.assets.configure do |env|
  # override the default location of tmp/cache/assets
  env.cache = ActiveSupport::Cache::FileStore.new("read-only-cache/assets")
end
```

Now running this command
```
$ RAILS_ENV=production ./bin/rake assets:precompile
```
should generate assets in `read-only-cache/assets` and `public/assets`.



## Login

Sandstorm can handle login for your app.
It proxies all requests and inserts special headers
indicating the name and ID of authenticated users.
How you use this information depends on your app's
authentication scheme and User model.

### Devise

[Devise](https://github.com/plataformatec/devise)
is a authentication library commonly used by Rails apps.
It has a mechanism for adding pluggable authentication shemes
called "strategies". To hook into it, you can add something
like this to `config/initializers/sandstorm_strategy.rb`:

```ruby
module Devise
  module Strategies
    class Sandstorm < Authenticatable
      def authenticate!
        userid = request.headers['HTTP_X_SANDSTORM_USER_ID'].encode(Encoding::UTF_8)
        username = URI.unescape(request.headers['HTTP_X_SANDSTORM_USERNAME']).force_encoding(Encoding::UTF_8)
        u = User.where(username: userid).first
        if !u
          opts = {}
          opts[:name] = username
          opts[:id] = userid
          u = User.new(opts)
          if u.save
            Rails.logger.info 'User was successfully created.'
          else
            Rails.logger.error 'User could not be created'
            Rails.logger.error u.errors
          end
        end

        success!(u)
      end
      def valid?
        !!request.headers['HTTP_X_SANDSTORM_USER_ID']
      end
    end
  end
end
```

And then edit `config/initializers/devise.rb` to have the following block somewhere in `Devise.setup`:
```ruby
Devise.setup do |config|
  ...
  config.warden do |manager|
    manager.intercept_401 = false
    manager.strategies.add(:sandstorm, Devise::Strategies::Sandstorm)
    manager.default_strategies(:scope => :user).unshift :sandstorm
  end
end
```

## Boot Time

Rails apps are not typically optimized for startup time.
However, fast startup is very important
for Sandstorm apps, because they are aggressively spun down when not in use.
Worse, Ruby's strategy for loading gems
does not interact well with `spk dev`, so startup times
in development mode can get quite long -- sometimes on the order of minutes.

You have a few ways to deal with this.

The first is to remove dependencies that don't make
sense for a Sandstorm port.
For example, any gems that handle authentication can
be removed, because you're just going to rely on Sandstorm for authentication.
This includes omniauth, rack-attack and oauth gems.
Also, you can probably do away with fancier web servers like
Unicorn and Thin; WEBrick ought to work just fine for a Sandstorm app.

If your app uses a task runner like Foreman,
it might be adding a full second to your (non-dev-mode) startup time!
It's more efficient to launch your processes from startup shell scripts,
and maybe append something like
`2>&1 | awk '{print "sidekiq: " $0}'`
so you can distinguish the log output.

`bundle exec` is also somewhat expensive, and all that it does is populate
environment variables.

If you're feeling particularly ambitious, you could
try to eliminate entirely your app's runtime dependency on Bundler,
as discussed in [this blog post](http://andre.arko.net/2014/06/27/rails-in-05-seconds/).
If you're feeling even more ambitious, you could develop a general tool
that statically does what Bundler.setup and Bundler.require do dynamically.

Finally, you should realize that you don't need to do all your
development through `spk dev`. If you `spk pack` and install your
app, you can still edit the code in-place in the `var/sandstorm/apps/<pkdId>`
directory where it was installed.


## Miscellany

### Referer header

Sandstorm does not forward the `Referer` header,
so things like `redirect_to :back` will fail.

### Javascript Runtime

The execjs gem wants a javascript runtime to exist on startup.
If you precompile your assets,
there's a good chance that you don't actually
need a javascript runtime in your packaged app.
In that case, you can get away with adding an empty `usr/bin/node` file
to your app, just to appease execjs. (Note that the file has to be marked
executable.)

For example, in your source directory, do:

    touch empty-file
    chmod +x empty-file

Then add this to your `searchPath` in `sandstorm-pkgdef.capnp`:

    (sourcePath = "empty-file", packagePath = "usr/bin/node"),

### Migrations

Logically, we want to do `rake db:migrate` every time we start up the app,
but that might be really expensive.
Instead, your app should write its version somewhere
and invoke `rake db:migrate` only when it detects a change.
