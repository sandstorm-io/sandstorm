
import { Template } from "meteor/templating";
import { Match, check } from "meteor/check";
import { globalDb } from "/imports/db-deprecated.js";
import { GrainView } from "/imports/client/grain/grainview.js";

Template.sandstormGrainSettingsPage.onCreated(function() {
  const instance = Template.instance();
  instance.subscribe("scheduledJobs");
  instance.autorun(() => {
    check(Template.currentData(), { grain: GrainView });
  });
})

Template.sandstormGrainSettingsPage.helpers({
  scheduledJobs() {
    const data = Template.currentData();
    return globalDb.collections.scheduledJobs.find({grainId: data.grain.grainId()});
  }
});

Template.sandstormGrainSettingsPage.events({
  "click .grain-settings-back-button": function(_event: unknown) {
    Template.currentData().grain.setShowSettings(false);
  },
})

Template.sandstormGrainSettingsScheduledJob.onCreated(function () {
  Template.instance().autorun(() => {
    check(Template.currentData(), {
      job: Match.ObjectIncluding({
        name: { defaultText: String },
        period: String,
      }),
    });
  });
});


Template.sandstormGrainSettingsScheduledJob.helpers({
  description() {
    return Template.currentData().job.name.defaultText;
  }
})
