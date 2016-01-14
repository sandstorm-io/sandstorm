## How to view these docs

https://docs.sandstorm.io/

## How to edit these docs

Run the following.

```
virtualenv env
env/bin/pip install mkdocs
env/bin/pip install markdown-inline-graphviz
(cd .. ; docs/env/bin/mkdocs serve)
```

Then visit http://localhost:8000/

## How to deploy to docs.sandstorm.io

- Ask Asheesh to share a particular GitWeb Pages grain with you.

- Do a `git clone` of that repository into a directory, like:

```
git clone https://my_repo@api.sandstorm.example.com sandstorm-docs
```

- Run `generate.sh` to re-generate the docs, then commit them to this git repo.

```
bash docs/generate.sh -d sandstorm-docs
```


- Run `generate.sh` with the `-p` flag to actually push them to the live site.

```
bash docs/generate.sh -d sandstorm-docs
```
