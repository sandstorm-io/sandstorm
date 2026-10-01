# Sandstorm's acme-dns-01-gcp fork

This package is a Node 22 modernization of
[`acme-dns-01-gcp`](https://github.com/latacora/acme-dns-01-gcp). It was
imported from npm release 0.0.10, upstream Git revision
`154ba7e2cfd04a676e8dcdb990a2f20975afc9f7`, and remains licensed under
MPL-2.0.

The public ACME DNS plugin interface and configuration keys are preserved.
Sandstorm's fork replaces the abandoned Google Cloud DNS 2.x client with the
supported 5.x client and removes unused runtime dependencies.
