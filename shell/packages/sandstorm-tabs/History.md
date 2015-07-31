2.2.0
=====

* Pass slug into onRender as the first argument, just like it's passed into onChange.

2.1.5
=====

* Fix onRender.

2.1.4
=====

* Try to fix docs display on Atmosphere (#6).

2.1.3
=====

* Fix dynamic tab tracking.
  * When the array of tabs changes, set the active tab to the first tab in the array if the existing active tab isn't in
    the new array.
* Remove dependency on `ReactiveArray` and use `Blaze.ReactiveVar` instead.
* Remove `{{#if tabs}}` expression from `trackTabs` in `dynamicTabs` template--of course there will be tabs.
* Update docs.

2.1.1-2.1.2
===========

* Update package.js to fix example template loading and limit files to client-side.

2.1.0
=====

* Add `tabContent` block helper to wrap tab content areas.
  * Removes the need to use jQuery to show/hide tab content.
  * Allows Blaze logic to be used in tabbed interface content block, for example to control permissions. Before, this would
    sometimes cause a race condition that would run the jQuery to add attributes to tab content containers before they rendered.
  * Tab content areas wrapped in `tabContent` can be defined out-of-order and still work properly.
  * The simpler `<div>` based content areas are still supported.
* Support passing interface-level context into tabs content block.
* Update example code and docs.

2.0.0
=====

* Change `activeTab` template helper to `isActiveTab` to prevent name clash with an `activeTab`
  expression, as seen in the `dynamicTabs` example.
  * Breaks API from 1.0, but should be a very easy update.

1.1.0
=====

* Add support for `onRender` callback specified in the tabs array.
* Add `dynamicTabs` example.

1.0.0
=====

* Manually tested working version.
* Includes `basicTabs` example template.
* Supports router integration.
  * The `onChange` callback, which runs every time a tab changes and gives access to the new slug,
    allows tabs to change active route if desired.
  * A reactive `activeTab` value can be passed into the template, so an external route or var
    can dictate the currently active tab.
* Docs written.
