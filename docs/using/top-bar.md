# Using the Sandstorm top bar

## Overview of the bar

When an app is running in Sandstorm, Sandstorm provides navigation elements at the top of the screen.

You can see an example by opening an [EtherCalc demo grain](https://demo.sandstorm.io/appdemo/a0n6hwm32zjsrzes8gnjg734dh6jwt7x83xdgytspe761pe2asw0).

## Summary of the elements

* Sandstorm logo: Click this to return to the homepage of the Sandstorm shell, where you can view your apps and documents.

* Name of grain (in this case, "Untitled EtherCalc spreadsheet"): Click this to rename the current grain. At the moment, the app does not know what you named this grain.

* Size (for example, "10.2 kB"): This is the total amount of storage consumed by this particular grain. Some apps are more lightweight than others, and this allows you to get a sense of which grains are consuming a lot of resources.

* Share access: Click this to add collaborators on the grain.

* Move to trash: Click this, and after you confirm, Sandstorm will move this grain to your trash. You will have 30 days to undo this action, after which the grain will be deleted.

* Show Debug Log: Click this to see stdout and stderr from the app.

* Download Backup: Click this to receive a ZIP file containing the data that supports this grain -- specifically, the full contents of `/var`. Note that there is no "wrapper directory" (discussed [here](https://github.com/sandstorm-io/sandstorm/issues/240)). Note also that if you attempt to restore this data, but you have upgraded the app, things might not work properly.

* Restart App: Click here to stop and start the app process. You should only ever need to click this if something has gone wrong. (Arguably, this button belongs in some kind of "Developer" menu.)

* Get Webkey link: Click this to create an API token that you can provide to mobile apps, command line automation, or other non-browser interaction methods for this grain. Any logged in user can do this.
