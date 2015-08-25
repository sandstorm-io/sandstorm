## Login providers

At the moment, Sandstorm supports federated authentication via GitHub
and Google. Sandstorm also supports passwordless email login (think
"password reset as login").

## Changing ownership of a grain

At the moment, there is no web-based interface for changing the owner
of a grain.

If you need to do this, you will have to use Sandstorm's built-in
MongoDB shell to modify the underlying data.

To do that, first launch the built-in MongoDB shell by running the
following.

```bash
$ sudo sandstorm mongo
```

You will see a prompt that looks like this.

```bash
ssrs:PRIMARY>
```

If you know the user ID you need to change, you can run a query like this:

```bash
db.grains.update({userId: 'zwQWvRJ4Gh8jzEegd'}, {$set: {userId: 'WvCL4RcWQBsMKdajj'}}, {multi: true})
```

It will print a message like this on success.

```bash
WriteResult({ "nMatched" : 9, "nUpserted" : 0, "nModified" : 9 })
```

Here is one way to list all users. If you need to search for the user
ID you need, note that names are stored within the `profile.name`
attribute.

```
> db.users.find()
```

## Group permissions

At the moment, Sandstorm does not support creating groups of users,
nor sharing access to a grain with a whole group of users at once. We
expect this to change in the fullness of time.
