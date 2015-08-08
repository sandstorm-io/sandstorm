About
-----

Build any tabbed interface:

* *really easily*.
* *with custom templates*.
* *with router integration*.
* *and sticky tab states*.

### Features

**Instance-scoped.**

All instances of tabbed interfaces are self-contained and individually reactive.

**Sticky state.**

When switching to a new tab, the content of the previous tab is preserved.

**Callbacks with access to instance context.**

Specify functions to run when things happen, using the `onChange` or `onRender` callbacks.
Easily integrate with routers.

**Active tab hook.**

Specify the currently active tab from a template helper if you want--just pass the slug into the tabs block.

**Dynamic tabs support.**

Tabs are provided using a template helper. 
If you change the tabs in that helper in a way that triggers a reactive re-run, 
your tabs block will respond to the change.
If the last-active tab is no longer available, a new tab will be automatically selected.

**Doesn't break normal Blaze functionality.**

Within a tabs block, template logic will work as expected. Just make sure to use the `{{#tabsContent}}` blocks to wrap your tabbed content areas.

### Example

[View the Live Example](http://tabs-example.meteor.com)

Install
-------

`meteor add templates:tabs`

This package works on the client-side only.

Usage
-----

#### Basic use

Try the included `basicTabs` template. First, register it with ReactiveTabs:

```javascript
ReactiveTabs.createInterface({
  template: 'basicTabs',
  onChange: function (slug, template) {
    // This callback runs every time a tab changes.
    // The `template` instance is unique per {{#basicTabs}} block.
    console.log('[tabs] Tab has changed! Current tab:', slug);
    console.log('[tabs] Template instance calling onChange:', template);
  }
});
```

Then, provide tabs like this in a parent template.

```javascript
Template.myTemplate.helpers({
  tabs: function () {
    // Every tab object MUST have a name and a slug!
    return [
      { name: 'People', slug: 'people' },
      { name: 'Places', slug: 'places' },
      { name: 'Things', slug: 'things', onRender: function(slug, template) {
        // This callback runs every time this specific tab's content renders.
        // As with `onChange`, the `template` instance is unique per block helper.
        alert("[tabs] Things has been rendered!");
      }}
    ];
  },
  activeTab: function () {
    // Use this optional helper to reactively set the active tab.
    // All you have to do is return the slug of the tab.

    // You can set this using an Iron Router param if you want--
    // or a Session variable, or any reactive value from anywhere.

    // If you don't provide an active tab, the first one is selected by default.
    // See the `advanced use` section below to learn about dynamic tabs.
    return Session.get('activeTab'); // Returns "people", "places", or "things".
  }
});
```

Finally, wrap your content with the `basicTabs` block helper:

```handlebars
<template name="myTemplate">

  <!-- Use `name` to add a custom class to the outer container -->
  {{#basicTabs name="" tabs=tabs}}
    <!--
      There are two ways to define content for your tabs:

      1. Wrap each tabbed section in a blank `<div></div>`.
         Sections must correspond with the order of the tabs you specified.

      2. Wrap each tabbed section in the provided block helper (RECOMMENDED!).
         `{{#tabContent slug="nameOfSlug"}} ... {{/tabContent}}`
         These can be defined in any order you like.
    -->
    {{#tabContent slug="people"}}
      <h2>People</h2>
      <button class="add-people">
        Add People
      </button>
    {{/tabContent}}

    {{#tabContent slug="places"}}
      <h2>Places</h2>
      <button class="add-places">
        Add Places
      </button>
    {{/tabContent}}

    {{#tabContent slug="things"}}
      <h2>Things</h2>
      <button class="add-things">
        Add Things
      </button>
    {{/tabContent}}

  {{/basicTabs}}

</template>
```

#### Advanced use

Try the included `dynamicTabs` template. Just register it with ReactiveTabs first.

```javascript
ReactiveTabs.createInterface({
  template: 'dynamicTabs',
  onChange: function (slug) {
    console.log('[tabs] Tab has changed:', slug);
  }
});
```

View that template's source code, and note this:

```handlebars
{{#if activeTab}}
  {{trackActiveTab activeTab}}
{{/if}}

{{trackTabs tabs}}
```

These helpers allow us to sync data from the parent template with internal data in the tabbed interface.

This presents us with some interesting abilities, detailed below.

**1. Changing active tab from the parent template**

Sometimes, you want to change active tab reactively--for example, based on a route.

To do this, you need your ReactiveTabs interface to respond when you change your `activeTab` helper in the parent template.

Enabling this functionality is simple:

* Make sure you specify an `activeTab` helper in the parent template, as we did in the first example.
* Pass `activeTab` into your block helper, like `{{#dynamicTabs tabs=tabs activeTab=activeTab}}`.
* Include `{{trackActiveTab activeTab}}` at the top of your tabbed interface template (see below).
* The value of `activeTab` can be either:
  * **slug** (a string, the name of the currently active slug).
  * **tab** (an object, including at least the `slug` property).

**2. Changing the number or order of tabs dynamically**

Usually, you never need to update your array of tabs. But if you do, ReactiveTabs can handle it.

Here's what you need to change to work with dynamic tabs:

* At the top of your tabbed interface template, but below any `trackActiveTab` expression, add `{{trackTabs tabs}}` (see below).
* Make sure you're wrapping your tab content areas using `{{#tabContent slug="nameOfSlug"}}` rather than a blank `<div>`.

#### Roll your own template

Turn any compatible template into a tabbed interface by calling `ReactiveTabs.createInterface()`.

Follow this model:

```handlebars

<template name="yourTabbedInterface">

  <div class="yourTabbedInterface-container">

    <!-- These are optional if you want to track parent data (see above). -->
    {{#if activeTab}}
      {{trackActiveTab activeTab}}
    {{/if}}

    {{trackTabs tabs}}

    <!-- You can put the tabs anywhere and style them however you want! -->
    <ul class="tabs-list">
      {{#each tabs}}
        <li class="tab-item {{isActiveTab slug}}">{{name}}</li>
      {{/each}}
    </ul>

    <!-- Here's where the active tab's content will be displayed. -->
    <!-- Make sure you include the entire snippet below (with context). -->
    <div class="tabs-content-container">
      {{> UI.contentBlock
          context=__context__
      }}
    </div>

  </div>

</template>

```

And then, as you saw above:

```javascript
ReactiveTabs.createInterface({
  template: 'yourTabbedInterface',
  onChange: function (slug, template) {
    console.log('[tabs] Tab has changed:', slug);
  }
});
```

Now you can go...

```handlebars
{{#yourTabbedInterface tabs=tabsHelper}}

  <!-- First tab's section. -->
  <div></div>

  <!-- Second tab's section. -->
  <div></div>

  <!-- And so on... -->
{{/yourTabbedInterface}}
```
In this example, `tabsHelper` has the array of tab objects.

#### How to specify tabs

Tabbed interfaces created with this package exist as template block helpers.

These block helpers require an array of tabs to be passed into them:

```handlebars
{{#yourTabbedInterface tabs=thisIsTheArrayOfTabs}}
  <!-- Content. -->
{{/yourTabbedInterface}}
```

Each tab in the array exists as an object with the following properties and methods:

Field     | Type       | Required
:---------|:-----------|:---------
name      | *String*   | **Yes**
slug      | *String*   | **Yes**
onRender  | *Function* | No

```javascript
var tabs = [
  { name: 'People', slug: 'people' },
  { name: 'Places', slug: 'places' },
  { name: 'Things', slug: 'things', onRender: function() {} }
];
```

Slugs should be URL-compatible strings without capital letters or spaces.

**To be extra clear: you must provide both name and slug.**

Contributors
------------

* [Jon James](http://github.com/jonjamz)
* [Andrew Reedy](http://github.com/andrewreedy)

My goal with this package is to keep it simple and flexible, similar to core packages.

As such, it may already have everything it needs.

**Please create issues to discuss feature contributions before creating a pull request.**
