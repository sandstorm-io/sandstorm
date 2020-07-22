Apps submitted to the [Sandstorm App Market](https://apps.sandstorm.io/) go
through an app review process. This page serves to both inform developers
and the community about the process, and serve as a guide to app reviewers.

## New app approval process

When an app is submitted to the app market, it becomes immediately available
on the [experimental market](https://apps.sandstorm.io/?experimental=true) for
testing and evaluation. App reviewers are notified that a new package is in
the queue.

During app review, an app reviewer will email the developer at the contact
email listed in the package metadata, introducing themselves and covering the
review process. The reviewer will provide feedback and advice on the submitted
app, which may included both approval-blocking issues and suggested changes or
fixes. The reviewer will also make sure the metadata displays correctly in the
market and appears to accurately depict the submitted app, and if applicable,
may look at the source repository with an eye for Sandstorm-specific changes
to the code.

The app developer can then incorporate that feedback and resubmit, or if none
of the feedback was approval-blocking, request the app be approved as already
submitted. When the app reviewer approves the package, they will notify you as
the App Market does not contact developers directly.

## App update approval process

Generally speaking, app review for app updates moves significantly faster. An
app reviewer should test both new grains and grain updates of the app, with a
focus on ensuring users will not lose data in existing grains when they get the
update. If the app is open source, the app reviewer should verify that the update
was pushed to the source repository as well prior to approval.

The reviewer may look at the changelog and commit history to narrow down
what new features or changes should be tested, and may reach out to the
developer with suggestions or feedback. However, in many cases, the app reviewer
will simply approve the update after verifying its functionality and notify the
developer that it has been approved.

## Approval-blocking issues

The Sandstorm App Market is a fairly permissive environment. While you may
receive feedback about performance, functionality, or usability, we largely
require only that your app works and that it does not lose data.

We will reject an app which crashes immediately and does not function as
advertised, for example. This can often occur when the package is missing files
that were present in the dev environment and wasn't adequately tested prior to
submission.

The latter concern often occurs when a pure client app is submitted up that
implements localStorage as its storage medium, which Sandstorm does not effectively
support. This can often be tested by storing some information in a grain, allowing
Sandstorm to shut down that grain, and then opening it again and seeing if things
persisted that an ordinary user would expect to persist between sessions.

Finally, the App Market may reject apps which present security or privacy issues
that fall outside of what a Sandstorm user would expect when using the app. This
can mean it requests overly-broad permissions when making Powerbox requests or
uses client-side loading to load scripts which share unexpected information outside
of the Sandstorm sandbox. For example, we may block approval on an app which attempts
to load an analytics script from an outside server, or does not make it suitably
clear to a user why it needs certain outside network access prior to requesting it.

**Note:** Client-side loading is a known gap in Sandstorm's security model that we
intend to close. Not only is misuse of it a security or privacy issue, it's use may
lead to apps that break when Sandstorm closes this gap.

## Commercial or proprietary apps

The Sandstorm App Market supports both commercial and proprietary apps, however
official support for app purchase and licensing is not currently available. For an
app that is merely closed source, but free, this may not pose an issue. For apps
which require some form of licensing to function, we expect at minimum that the
app description clearly and prominently specifies the licensing requirements and
activation method. Sandstorm apps should be as self-sufficient as possible, so a
license key method using some sort of signing that does not need to call home is ideal,
however, a check with a licensing server may be acceptable if it is narrow in scope,
and utilizes the Powerbox to get the user's consent for their server to contact
yours. We would also encourage the app to have at least a minimal level of functionality
such as a trial or limited version, such that users can experience the app before
deciding on a purchase. As this is a territory the Sandstorm app review team hasn't
spent a lot of time on, interested parties may wish to reach out to the Sandstorm
community for feedback prior to committing significant work here.
