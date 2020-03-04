Here in the **Sandstorm developer hub**, you will find to resources to help you build new
apps on top of Sandstorm, package existing apps, and understand how apps and Sandstorm fit together.

<div class="developer-next-steps">
<a class="next-step tutorial" href="../vagrant-spk/packaging-tutorial/">New? Try tutorial</a>
<a class="next-step why" href="https://sandstorm.io/developer">Why Sandstorm</a>
<a class="next-step discussion" href="https://groups.google.com/d/forum/sandstorm-dev">Community Q&amp;A</a>
<a class="next-step app-market" href="https://apps.sandstorm.io/">See App Market</a>
<a class="next-step live-chat" href="https://kiwiirc.com/client/irc.freenode.net/?channel=#sandstorm">Live chat via IRC</a>
<a class="next-step demo-app" href="https://apps.sandstorm.io/app/0dp7n6ehj8r5ttfc0fj0au6gxkuy1nhw2kx70wussfa1mqj8tf80">Try a demo app</a>
</div>
<!-- <div class="next-step">Sample apps in PHP, Python, Meteor</div> -->

Sandstorm apps can be in **any language** so long as it runs on Linux (PHP, Python, Node.js, Ruby,
etc.). The app bundles its dependencies so it runs in a consistent environment. Sandstorm handles
user management and mitigates [95% of security issues](using/security-non-events.md). App authors
don't have to run servers since users run your app on their own servers. Sandstorm's "grain" model
allows developers to rely on Sandstorm for supporting multiple instances/documents rather than
writing that code in the app. Read more on the [developer features
page](https://sandstorm.io/developer).

## Creating an app package

- **Tutorial**: [Five minute packaging tutorial](vagrant-spk/packaging-tutorial.md)
- **What makes a great Sandstorm app**: [App Developer Handbook](developing/handbook.md)
- **Language support**: [Platform stacks for Meteor, Python, PHP, Node.js](vagrant-spk/platform-stacks.md) | [Other](vagrant-spk/platform-stacks.md#diy-platform-stack)
- **Code & service dependencies**: [Code dependencies](vagrant-spk/code-dependencies.md) | [MySQL](vagrant-spk/services.md#mysql) | [Other databases & services](vagrant-spk/services.md#other-services)
- **Troubleshooting**: [Package troubleshooting](developing/troubleshooting.md)
- **vagrant-spk in depth**: [Installation](vagrant-spk/installation.md) | [Customizing & understanding vagrant-spk](vagrant-spk/customizing.md)

<!--

Not written yet:

- **File storage & URLs**:  [Filesystem layout & permissions](developing/filesystem-layout.md) | [Static resources like CSS/JS]()

- **SPK files**: [Publishing to the app list](packaging/app-list.md) | [SPK file size](packaging/file-size.md)

-->

---

## How to leverage the community

The Sandstorm ecosystem is full of people who want to promote your app, give you feedback, and use
it.

- **Getting help**: [Community feedback and Q&A](https://groups.google.com/d/forum/sandstorm-dev) | [Real-time IRC chat on freenode](https://kiwiirc.com/client/irc.freenode.net/?channel=#sandstorm) | [Watch presentations on the Sandstorm YouTube channel](https://www.youtube.com/channel/UC8xKZRW86Fa9W00uAppBXXg)
- **Publicity**: [Give a meetup/conference talk about your app](https://sandstorm.io/news/2015-12-17-community-talks) | [Public demo service for all Sandstorm apps](https://sandstorm.io/news/2015-02-06-app-demo)
- **Read more**: [All community resources](https://sandstorm.io/community)

---

## All about grains

When a user runs an app within Sandstorm, they create one or more _grains_ of the app.
Read about how grains work and how they affect your app.

- **Grain URLs and the grain-frame**: [URLs, domain names, page titles](developing/path.md)
- **Sandstorm system architecture**: [How Sandstorm works](using/how-it-works.md) | [Grain isolation and other security practices in Sandstorm](using/security-practices.md)
- **How to choose the granularity for your app**: [granularity](developing/handbook.md#is-granular)

---

## App sharing, publishing, & permission levels

Each app instance (aka "grain") is private by default to the user who
created it. Read these documents to learn how access control works.

- **Login & permissions**: [User authentication & permissions](developing/auth.md)
- **Making content accessible outside Sandstorm**: [Publishing static content, including to the user's domain](developing/web-publishing.md) | [Exporting HTTP APIs for mobile, desktop, Javascript clients](developing/http-apis.md)
- **Further reading**: [Delegation is the Cornerstone of Civilization](https://blog.sandstorm.io/news/2015-05-05-delegation-is-the-cornerstone-of-civilization.html)

---

## Network access

By default, Sandstorm runs each app instance with no network
access. Read these documents to configure an app to get access to
services on the Internet or to each other.

- **Supported protocol**: [SMTP (email)](developing/email-from-apps.md)
- **Other protocols**: Work in progress.
- **Inter-app communication**: Work in progress.

---

## Raw Sandstorm packaging

Most Sandstorm packages use [sandstorm-http-bridge](using/how-it-works.md) and
[vagrant-spk](vagrant-spk/customizing.md). However, these tools are independent
and optional.

- **Minimalist packaging**: [Raw SPK packaging guide](developing/raw-packaging-guide.md)
- **Raw packaging & integration guides**: [Python](developing/raw-python.md) | [Ruby on Rails](developing/raw-ruby-on-rails.md) | [Pure client apps](developing/raw-pure-client-apps.md)

---

## Powerbox & raw Sandstorm APIs via Cap'n Proto

To make components easier to isolate while retaining high performance, most communication in
Sandstorm occurs using Cap'n Proto. Cap'n Proto files in the Sandstorm source repository contain
useful design or implementation details. Note that Sandstorm typically depends on the **unreleased
git master** of capnproto. Configuration files such as `sandstorm-pkgdef.capnp` use Cap'n Proto as
their file format.

- **Overview**: [Cap'n Proto website](https://capnproto.org/) | [How Cap'n Proto makes Sandstorm more secure](https://sandstorm.io/news/2014-12-15-capnproto-0.5)
- **Implementation guide for app authors**: [Documentation on powerbox](developing/powerbox.md)
- **Example**: [Explanation of how drivers will work, found within ip.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/ip.capnp)
- **Cap'n Proto implementations**: [C++, Erlang, Go, Javascript, Python, Rust, and others](https://capnproto.org/otherlang.html)
- **Further reading**: [A list of all Cap'n Proto files in the source repository](https://github.com/sandstorm-io/sandstorm/search?l=cap%27n-proto&p=2&q=type%3Acapnp+&utf8=%E2%9C%93)

---

## Documentation on how to contribute to Sandstorm

To see all the ways to contribute to Sandstorm, read the [Sandstorm community page](https://sandstorm.io/community).

To learn about contributing code to Sandstorm itself, read [how Sandstorm works](using/how-it-works.md) and the [GitHub wiki](https://github.com/sandstorm-io/sandstorm/wiki).
