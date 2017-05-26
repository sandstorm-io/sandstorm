# Sandstorm on Mobile

Sandstorm is primarily a web platform, but should be easy to access from mobile and integrate with mobile apps.

## App clients

Many Sandstorm apps will have mobile clients that the user wishes to connect to them.

Many of these app wish to use HTTP-based interfaces.

For a client app to reach its corresponding server app's HTTP interface, it needs to receive a webkey. The user can create new webkeys in the Sandstorm interface.

Normally a webkey is represented as a URL in the form `https://<host>#<token>`. This indicates that the API is available at `https://<host>` and that the client should use the header `Authorization: bearer <token>` on all requests.

Copy/pasting a webkey on a mobile UI is annoying, so Sandstorm allows apps to generate an "offer template" which contains a clickable link using a special URL scheme `clientapp-<name>:<webkey>`, e.g. `clientapp-rocketchat:https://api-dfb404389a9a4855914507550154f21b.example.sandcats.io#b2EP1ZqYSPMM9RV1P9A0usmQL1NQEIPTPK2uofhfvVH`. The mobile app can register a URL handler for `clientapp-<name>` (where `<name>` is chosen by the app) in order to handle a click on this URL and auto-configure the app.

Sometimes, it is not possible to update the client app, especially when implementing a standard protocol that has many client apps (for example, WebDAV, CalDAV, etc.). Usually, these apps support HTTP basic auth (username/password). To that end, Sandstorm will allow the token part of a webkey to be used as a basic auth password (the username is ignored and can be anything). So, the Sandstorm app can render an offer template which instructs the user to use a host (the host part of the webkey), an arbitrary username (perhaps their preferred handle), and a password (the token part of the webkey), as three separate fields. This is inconvenient for the user, but there's not much better we can do here.

TODO(feature): The above methods of configuring an app require opening the Sandstorm app in a web browser on the user's phone, in order to click the auto-configure link or copy/paste the hostname and password. We should also make it possible for the application to display a QR code in the user's desktop browser which can then be scanned into their phone. The QR code could decode to the `clientapp` scheme described above. The QR code should also be clickable in case the user opens it in their mobile browser and wants to connect the native app on the same device.

## TODO(feature): Push notifications

Unfortunately, both iOS and Android push notification frameworks assume a centralized design. Each app can declare exactly one cloud server from which push notifications are delivered. For users to receive notifications directly from their Sandstorm server, they would need to recompile each mobile app they use to give it the appropriate server address.

Because most users do not want to do this, Sandstorm will operate a push notification relay through Sandstorm Oasis, which apps can set as their default notification source. It will also be possible for apps to specify a third-party relay, e.g. for apps that aren't Sandstorm-exclusive and already operate a relay for this purpose.

Unfortunately, as we understand it, relayed notifications will necessarily be visible to the relay operator, because (at least on iOS) the app cannot run its own code to decrypt the notification before it is displayed to the user.

Therefore, some admins may wish to disable notifications entirely, or require users to receive notifications strictly through a modified version of the Sandstorm app that talks directly to the correct Sandstorm instance.

## TODO(project): Sandstorm App

We would like to develop a native mobile client to Sandstorm for a couple reasons:

- (short-term) Improve the experience of using Sandstorm on Android: Sandstorm is currently difficult to use from Android. The main user interface can only be used in a browser, which is a poor experience compared to native apps. We have one app which has an Android client that can connect to its Sandstorm server -- TinyTinyRSS -- but the experience is poor, because it requires copy/pasting a webkey (URL) from the Sandstorm web interface. The app's apk must also be downloaded by opening the app in Sandstorm, again in a browser.
- (long-term) Position ourselves as an alternative app distribution mechanism and cloud services provider for independent Android distributions. Currently, Android is not very useful without Google's suite of apps (especially the Play store), but to legally bundle those apps with your Android phone or image, you must agree to onerous terms imposed by Google, which includes bundling all of Google's services. Basically, Android phones are either Google Phones or useless. Sandstorm could plausibly provide a new, independent option: instead of integrating your phone with Google services, integrate with your personal Sandstorm server. The Sandstorm app store could effectively replace the Play store; when you install an app on Sandstorm, the mobile client could automatically be pushed to your phone, ideally constrained by a Sandstorm-like permissions model. Essentially, you are no longer installing apps on specific devices.

### Short-term features

The following was written with an Android app in mind. iOS might be slightly different.

Probably, the app should be implemented using Meteor's Cordova integration, so that we can reuse the existing web UI implementation.

- On first run, the app should prompt the user to name the device, e.g. "Kenton's Nexus 5". This name will be used later for labeling API keys issued to this device.
- Next, the app will need to find your Sandstorm server.
  - Can we trigger an intent on opening an arbitrary Sandstorm server in your browser? If not automatically, we can at least have a "open in Android app" button on the server front page when opened from an Android user-agent.
- The app should offer to log you in using your Google or Github accounts registered with the Android account system.
- User can switch between known Sandstorm servers and accounts in the UI.
- The app talks to the Sandstorm server via Meteor's DDP protocol. Thus, the Meteor.publish()s and Meteor.method()s implemented by Sandstorm currently become the API for Android to use. (We may need to clean some of these up.) DDP libraries for Android exist.
- The app UI is basically a subset of the existing Meteor front-end.
  - The app's main view will be a file list, similar to Sandstorm presently.
  - Selecting a grain in the list will fire an intent for "Open a Sandstorm grain of type <appid>"
    - If an installed app responds, then an API key is passed to that app.
      - If the app has received a key for this grain before, try to send the same key.
      - Otherwise, create a new key whose petname is some combination of the device name and the app name.
    - If there is no installed app for the intent, check if the Sandstorm app recommends a particular Android client. If so, prompt the user to install it from the Play Store.
    - If there is no recommended app or the user doesn't want to install it, open the Sandstorm grain in a WebView.
      - Don't do this by displaying the Sandstorm frontend. Instead, call a Meteor method to create a new session and display its one-time hostname in the WebView.
      - Don't forget to send periodic keep-alive calls.
      - If the session is closed (disappears from the database), open a new one and refresh.
  - Long-pressing a grain should offer the option to create a shortcut to it on the home screen.
- The app should also accept "powerbox" intents: requests from other apps to access Sandstorm resources.
  - Initially, this intent should take the form "give me an API token for a grain with this app ID".
    - The Sandstorm client will let the user pick from their grains or create a new one.
    - If the Sandstorm server doesn't have the app installed, perhaps the user should be referred to the Sandstorm app store to install it?
  - Once the Powerbox is implemented in Sandstorm proper, the Android client should also allow requesting specific powerbox capabilities. This should result in a Cap'n Proto capability, which requires a Java Cap'n Proto implementation that supports RPC, which doesn't exist yet.
- Some day, Android apps should be able to public Cap'n Proto capabilities as well, having them reach the user's powerbox on their server, but this is not an immediate priority. (Also requires Cap'n Proto RPC in Java.)
