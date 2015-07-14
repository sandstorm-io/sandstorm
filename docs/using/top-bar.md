# Using the Sandstorm top bar

## Overview of the bar

When an app is running in Sandstorm, Sandstorm provides navigation elements at the top of the screen.

You can see an example here:

* [https://sandstorm.io/vote](https://sandstorm.io/vote) -- this redirects to a URL on `alpha.sandstorm.io`.

## Summary of the elements

* Sandstorm logo: Click this to return to the homepage of the Sandstorm shell, where you can view your apps and documents.

* Name of grain (in this case, "App Committee Voting"): Click this to rename the current grain. At the moment, the app does not know what you named this grain.

* Size (for example, "12.9 MB"): This is the total amount of storage consumed by this particular grain. Some apps are more lightweight than others, and this allows you to get a sense of which grains are consuming a lot of resources.

* Get Webkey link: Click this to create an API token that you can provide to mobile apps, command line automation, or other non-browser interaction methods for this grain. Any logged in user can do this.

For a grain where you are the owner, you will also see:

* Delete: Click this, and after you confirm, Sandstorm will remove the data that supports this grain. Be careful! There is no undo.

* Show Debug Log: Click this to see stdout and stderr from the app. (FIXME: Really both stdout *and* stderr? Not syslog also? Should check.)

* Download Backup: Click this to receive a ZIP file containing the data that supports this grain -- specifically, the full contents of `/var`. Note that there is no "wrapper directory" (discussed [here](https://github.com/sandstorm-io/sandstorm/issues/240)). Note also that if you attempt to restore this data, but you have upgraded the app, things might not work properly.

* Restart App: Click here to stop and start the app process. You should never need to click this. Probably it should move into a "Developer" menu.