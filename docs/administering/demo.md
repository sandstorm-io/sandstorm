# Demo mode

This page documents some features of the Sandstorm demo mode, which is the mode in which [demo.sandstorm.io](https://demo.sandstorm.io) runs. The code for demo mode is in the main Sandstorm repository but usually is not enabled.

## Purpose of demo mode

The main purpose of the demo mode is to let people learn more about the Sandstorm platform by using a Sandstorm instance without having to think about registering for an account.

A secondary purpose, the code for which is not yet fully implemented, is to enable people to try out Sandstorm _apps_ without having to think about registering for an account or "installing" the app.

## Data deletion

A demo user and their data is deleted one hour after the user is created. To learn about how, read the [code implementing the demo](https://github.com/sandstorm-io/sandstorm/blob/master/shell/shared/demo.js).

At the time of writing, the period of data deletion is not configurable.

## Enabling demo mode

Demo mode is mainly intended to run on [demo.sandstorm.io](https://demo.sandstorm.io), since the purpose is to show you what Sandstorm looks like before you've installed it. That said, you can enable it on your own installation.

To enable demo mode, add the following line to `sandstorm.conf`:

```
ALLOW_DEMO_ACCOUNTS=true
```

## App demos

When a Sandstorm instance allows demo accounts, a visitor can surf to:

`/appdemo/:appId`

(where `appId` is the key ID of an app installed on that server).

At that URL, we show a screen to the visitor indicating that their data will vanish in a hour. When they click on the "Try appName" button, they find themselves in a working instance of the app.

This hinges on the app named by `appId` being installed on the server.

Your app's ID can be found near the top of the package definition file (`sandstorm-pkgdef.capnp`), where it will be defined something like this:

    const pkgdef :Spk.PackageDefinition = (
      id = "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh",

To find the ID of an already-built `.spk` package, run `spk unpack` on it; it will print the ID to the console. For apps on the [Sandstorm app list](https://sandstorm.io/apps/), you can also look at the `data-app-id` attribute on the "install" button.