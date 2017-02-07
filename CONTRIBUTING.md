# Contributing to Sandstorm

So you want to contribute to Sandstorm. Awesome! This document will help you get started.

## Talk to us!

Before you start making changes to Sandstorm, you should join [the sandstorm-dev mailing list](https://groups.google.com/group/sandstorm-dev) and tell us what you're up to. We might be able to give you tips or warn you if someone is already working on the same thing.

You can also chat with us on IRC at #sandstorm on Freenode -- but don't be discouraged if no one answers; sometimes we're busy. :)

## Non-code contributions

There are many ways to contribute without writing code. Check out the [Sandstorm community page](https://sandstorm.io/community) for some ideas. The rest of this document focuses on code, since this is the code repository.

## How to hack on the code

To learn how to set up a dev environment and hack on the code, check out the documentation on [installing Sansdtorm from source](https://docs.sandstorm.io/en/latest/install/#option-4-installing-from-source).

## What to work on

Here are a list of projects and smaller tasks that YOU can do to help Sandstorm!

If you'd like to work on one of these tasks, [join the sandstorm-dev mailing list](https://groups.google.com/group/sandstorm-dev) and let us know! We'll let you know if anyone else is already working on the task and help you figure out what to do.

### Apps!

The easiest way to help Sandstorm is to write and/or package apps! See [the developer hub in the Sandstorm documentation](https://docs.sandstorm.io/en/latest/developing/) for how to get started.

### Internationalization (i18n)

We need someone to internationalize the Sandstorm interface so that it can be translated into multiple languages.

The first step of this project will probably involve integrating Sandstorm with the tap-i18n framework (a localization framework for apps that use Meteor and Blaze). You will need to systematically go through our HTML templates and replace English-language text with calls to the i18n framework and message codes, which reference into the localization table. Once a localization table exists, we volunteers can translate it into many languages. This much should be straightforward and should get us 90% of the way there.

As part of this project, we will want to add UI to the account settings page through which users can set their language. If the user sets a language, it should override the `Accept-Language` HTTP header both for the Sandstorm interface and for apps.

As a longer-term project, we would like to create a localization framework for apps. Apps can already localize themselves based on the `Accept-Language` header, and some have done so. However, there are some issues we'd like to improve on:

1. In many places, apps communicate strings to Sandstorm, using the `LocalizedText` Cap'n Proto struct defined in `util.capnp`. This struct is possibly not as well-designed as it should be. Currently, the vast majority of apps use only the `defaultText` field, specifying English-language text. We should extend this struct to support some sort of message code framework and make Sandstorm support it.

2. We should consider creating a framework by which apps can be translated by volunteers without coordinating with the app developer. One way this could work is that each app could define a set of message codes and could define English-language text for those message codes, but translation tables could be distributed separately from the app itself. Sandstorm could maintain a service which allows people to contribute translations for any app and then redistributes those translations automatically to all Sandstorm servers, without the app author needing to be involved.

### Better Tests

_If you volunteer for this, you will be a hero!_

Let's face it: no one really likes writing tests. But automated tests are absolutely essential for high-quality products, and especially open source projects. Automated tests allow us to be sure that changes to Sandstorm don't introduce new bugs. This is useful even for seasoned developers, but is absolutely essential for new contributors trying to help out. New volunteers won't know what their changes might break, and it is much better that they find out by running an automated test, rather than waiting for an experienced developer to review their code.

Sandstorm uses a test framework based on Selenium and Nightwatch. This framework runs a real web browser and simulates real clicks on UI elements in order to verify that they do what they are supposed to do. It's fairly easy to write these tests, because you're simply writing a script that does the things _you_ would do -- click buttons and links, type text, etc.

Check out [`/tests`](https://github.com/sandstorm-io/sandstorm/tree/master/tests) in the Sandstorm source tree to learn about tests.

Here is an incomplete list of things we need to test better:

- SAML and LDAP login. (Requires running a SAML and an LDAP server in the background to test against!)
- Account settinsgc page / profile editing.
- Backwards-compatibility (test various old app packages and make sure they still work).
- Quota enforcement.
- Subscriptions and payments.
- The admin UI.
- The sharing UI.
- Demo mode (seen primarily on Oasis).
- Dev tools (`spk`, etc.).
- Testing across all browsers (currently the tests run with Firefox only).

### New Authentication Mechanisms

Currently, Sandstorm supports authentication through E-mail, Google, Github, LDAP, and SAML. We'd also like to support things like PGP, Twitter, Facebook, OpenID, Indie Auth, etc.

Sandstorm has a framework for authentication which is relatively easy to extend with new types. But, you will want to consider the following:

- As more types are added, the potential for user confusion grows. You may want to implement [de-duplification of credentials](https://github.com/sandstorm-io/sandstorm/tree/master/roadmap/platform/accounts#todofeature-de-duplicating-logins) before adding too many login mechanisms.
- More generally, you may want to help fix Sandstorm's current problems with [profiles](https://github.com/sandstorm-io/sandstorm/tree/master/roadmap/platform/accounts#profile) being per-credential rather than per-account, as this will get worse when more credential types are introduced.
- Perhaps the authentication system should be extensible by apps! You may want to implement an API by which a Sandstorm app can offer a new way of authenticating.

### Improve Notifications

Sandstorm contains an [activity event API](https://github.com/sandstorm-io/sandstorm/tree/master/roadmap/platform/activity) which generates notifications. Currently, those notifications are delivered via the "bell menu" inside the Sandstorm UI. We'd like to send e-mail notifications as well, but we need to make sure that users are able to exercise tight control over this to prevent spam.

More generally, we would like to create a user interface allowing users to subscribe to (or mute) specific notification types and specific threads within specific apps or grains.

### Activity / Audit Logs

Related to notifications, we'd like to use the data that apps submit via the [activity event API](https://github.com/sandstorm-io/sandstorm/tree/master/roadmap/platform/activity) to generate an actual activity feed -- where users can see what's going on in their grains -- and a organization-wide audit logs -- where admins can find out what's going on globally.

### The App Market

The Sandstorm App Market needs some love.

[The code is here.](https://github.com/sandstorm-io/sandstorm-app-market)

The app market currently has no owner. We'd like someone to take over this code and make it better. You would have essentially free reign to make whatever improvements you deem fit. Sandstorm's designer, Nena, will be able to help design pretty graphics, so you only need to know how to code.

Longer-term, we think the app market should be rewritten entirely. Here's why:

The app market is a Meteor app, which generates all HTML dynamically on the client side in Javascript. This probably was not the right design for a web site that is mostly composed of static content. Among other problems, it is not search-engine-friendly.

Also, the app market currently isn't a Sandstorm app -- although it sources metadata from the "app index", which *is* a Sandstorm app, but exports only JSON, raw package files, and image files.

We'd like to re-design the app market to solve these problems. Perhaps the app index (whose code currently lives inside the main Sandstorm repository) should be extended to generate and serve static HTML content. However, we'll need to decide how to handle reviews. Ideally, reviews would live in an entirely separate database (grain) from the app index, for security reasons: it's very bad if someone compromises the app index, but less bad if someone compromises reviews.

### Sandstorm Distro

We'd like to develop a full Linux distro designed solely to run Sandstorm, so that people can install Sandstorm without setting up Linux first.

Sandstorm auto-updates without user intervention. The Sandstorm distro should do the same, all the way down to the kernel. When reboots are necessary, the administrator should be able to specify the best time for them to occur via the Sandstorm UI. Everything should be manageable via the Sandstorm web UI; no shells or config files necessary.

The Sandstorm distro should support secure boot, like ChromeOS and CoreOS.

Once we have a Sandstorm distro, we can use it to create VM images for easy deploy on OpenStack, AWS, Digital Ocean, Google Cloud, etc.

### Better Development Tools

Currently, Sandstorm's `spk` and `vagrant-spk` tools are designed to be very general, such that they can work for any tech stack. The down side of this is that they are not very easy to use for any particular stack.

In contrast, the [`meteor-spk`](https://github.com/sandstorm-io/meteor-spk) tool has made it very easy to package Meteor apps for Sandstorm, by taking advantage of specific knowledge of the way Meteor apps are organized. `meteor-spk` understands the Meteor package manager and thus can build a precise Meteor app package given a Meteor project tree.

We'd like to develop similar tools -- or maybe one combined tool -- which understand other common tech stacks and package managers. We imagine tools that understand package definitions and dependency lists for npm, rubygems, Pip (Python), Maven (Java), Cabal (Haskell), Nix (general), etc., and can use them to generate a package file in a precise, reproducible way.

### Documentation

Sandstorm maintains detailed documentation at [docs.sandstorm.io](https://docs.sandstorm.io), which is generated from [a directory in the source tree](https://github.com/sandstorm-io/sandstorm/tree/master/docs).

In theory, whenever someone adds a new feature to Sandstorm, they should add documentation.

In practice, the people writing code may not be very good at writing docs. Or they may just be lazy.

You can help Sandstorm by documenting things that aren't documented. Look especially for recent pull requests introducing new features which didn't add docs.

You can also help by simply prodding people to write docs for their changes. If someone submits an undocumented new feature, ask them to document it!

### Bite-sized issues

The [Sandstorm issue tracker](https://github.com/sandstorm-io/sandstorm/issues) features a label called ["bite-sized"](https://github.com/sandstorm-io/sandstorm/issues?q=is%3Aopen+is%3Aissue+label%3Abite-size). These are issues which should be relatively easy to fix, but which no one has gotten around to. Try fixing one! Be sure to post to the issue that you're working on it before you start, to make sure that no one else takes the same issue while you're working on it.

### Check the roadmap

The tasks listed above are the things we feel are most important right now. But, [the Sandstorm roadmap](https://github.com/sandstorm-io/sandstorm/tree/master/roadmap) is full of things we'd like to implement. Browse around and look for "TODO" indicators. If you find something interesting, consider taking it up!
