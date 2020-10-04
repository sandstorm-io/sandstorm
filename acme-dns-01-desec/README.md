# acme-dns-01-desec

deSEC DNS + Let's Encrypt for Node.js

This handles ACME dns-01 challenges, compatible with ACME.js and Greenlock.js.
Passes [acme-dns-01-test](https://git.rootprojects.org/root/acme-dns-01-test.js).

## Features

- Compatible
  - [x] Let's Encrypt v2.1 / ACME draft 18 (2019)
  - [x] [deSEC v1 API](https://github.com/desec-io/desec-stack)
  - [x] ACME.js, Greenlock.js, and others
- Quality
  - [x] node v6 compatible VanillaJS
  - [x] &lt; 150 lines of code
  - [x] **Zero Dependencies**

# Install

```bash
npm install --save acme-dns-01-desec
```

Generate deSEC API Token:

- <https://desec.readthedocs.io/en/latest/auth/tokens.html>

# Usage

First you create an instance with your credentials:

```js
var dns01 = require('acme-dns-01-desec').create({
	baseUrl: 'https://desec.io/api/v1', // default
	token: 'xxxx'
});
```

Then you can use it with any compatible ACME library,
such as Greenlock.js or ACME.js.

### Greenlock.js

```js
var Greenlock = require('greenlock-express');
var greenlock = Greenlock.create({
	challenges: {
		'dns-01': dns01
		// ...
	}
});
```

See [Greenlock Express](https://git.rootprojects.org/root/greenlock-express.js)
and/or [Greenlock.js](https://git.rootprojects.org/root/greenlock.js)
documentation for more details.

### ACME.js

```js
// TODO
```

See the [ACME.js](https://git.rootprojects.org/root/acme-v2.js) for more details.

# Tests

```bash
# node ./test.js domain-zone api-token
node ./test.js example.com xxxxxx
```
