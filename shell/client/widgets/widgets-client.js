Template.modalDialogWithBackdrop.onCreated(function () {
  // This keypress event listener which closes the dialog when Escape is pressed should be scoped to
  // the browser window, not this template.
  this.keypressListener = (evt) => {
    if (evt.keyCode === 27) {
      this.data.onDismiss && this.data.onDismiss();
    }
  };

  window.addEventListener("keydown", this.keypressListener);
  document.getElementsByTagName("body")[0].classList.add("modal-shown");
});

Template.modalDialogWithBackdrop.onDestroyed(function () {
  window.removeEventListener("keydown", this.keypressListener);
  document.getElementsByTagName("body")[0].classList.remove("modal-shown");
});

Template.modalDialogWithBackdrop.events({
  "click .modal"(evt) {
    if (evt.currentTarget === evt.target) {
      // Only dismiss if the click was on the backdrop, not the main form.
      const instance = Template.instance();
      instance.data.onDismiss && instance.data.onDismiss();
    }
  },

  "click .modal-close-button"(evt) {
    const instance = Template.instance();
    instance.data.onDismiss && instance.data.onDismiss();
  },
});

const focusAndScrollIntoView = function () {
  // When an error or success message appears on the page or is updated, we generally want to focus
  // it (for screenreader users) and scroll it into the view (for visual users), lest they miss the
  // message entirely.
  // Apparently firstNode is a #text node, and lastNode is the actual <div>, which is the only
  // actual node in the template source, because I have newlines and whitespace and comments.
  this.lastNode.focus && this.lastNode.focus();
  this.lastNode.scrollIntoView && this.lastNode.scrollIntoView();
};

Template.focusingErrorBox.onRendered(focusAndScrollIntoView);
Template.focusingSuccessBox.onRendered(focusAndScrollIntoView);
