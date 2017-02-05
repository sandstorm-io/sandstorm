# Background Processing

Most Sandstorm apps only run while the user has them open in a browser window, or while they are handling an API or RPC request. This saves resources as most apps would otherwise spend most of their time sitting idle, wasting RAM.

Some apps, however, need to perform background processing at other times. To do this, they must invoke a system API to schedule the processing.

## Ongoing tasks

An app may extend its running time by starting an ongoing task, which blocks the system from shutting down the app container until the task is marked complete.

While a task is ongoing, the user will see an ongoing [notification](../notifications) in their top bar to let them know that the app is using resources. The app can customize this notification in the usual way that notifications may be customized, but cannot hide the notification.

TODO(bug): If an app dies while performing an ongoing task, it should be automatically restarted.

## TODO(feature): Scheduled tasks

An app may schedule a task to occur at a specific time in the future, or on a regular interval.

By default, the API should push apps towards imprecise scheduling. For example, an app scheduled to run daily may run at any time during the day, as long as it runs once a day (though the platform will try to vary the timing only a little bit from day to day). This allows Sandstorm some flexibility to space out scheduled tasks or run them at off-peak hours.

Some apps may require precise timing -- such as an alarm app. This will be supported by the API, but discouraged. Blackrock may charge compute units at a higher rate to tasks scheduled at a precise time.

Like with ongoing tasks, the user should be informed of scheduled tasks via [notifications](../notifications). However, these notifications should probably be less prominent than ongoing tasks, perhaps merged together into one "N scheduled tasks" item which can be clicked on for more info.
