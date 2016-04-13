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
  this.firstNode.focus && this.firstNode.focus();
  this.firstNode.scrollIntoView && this.firstNode.scrollIntoView();
};

Template.focusingErrorBox.onRendered(focusAndScrollIntoView);
Template.focusingSuccessBox.onRendered(focusAndScrollIntoView);
