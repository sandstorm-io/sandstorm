## How to view these docs

https://docs.sandstorm.io/

## How to edit these docs

Run the following.

```
cd ~/projects/sandstorm
virtualenv tmp/docs-virtualenv
tmp/docs-virtualenv/bin/pip install mkdocs
tmp/docs-virtualenv/bin/pip install markdown-inline-graphviz
tmp/docs-virtualenv/bin/mkdocs serve
```

Then visit http://localhost:8000/

## How to deploy to docs.sandstorm.io

- Ask Asheesh to share a particular GitWeb Pages grain with you. It's
  located on https://alpha.sandstorm.io/.

- Do a `git clone` of that repository into a directory, like:

```
git clone https://my_repo@alpha-api.sandstorm.io/ sandstorm-docs
```

- Run `generate.sh` to re-generate the docs, then commit them to this git repo.

```
PATH=$PATH:$PWD/tmp/docs-virtualenv/bin bash docs/generate.sh -d sandstorm-docs
```


- Run `generate.sh` with the `-p` flag to actually push them to the live site.

```
PATH=$PATH:$PWD/tmp/docs-virtualenv/bin bash docs/generate.sh -d sandstorm-docs -p
```
