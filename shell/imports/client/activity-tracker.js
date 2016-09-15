class ActivityTracker {
  // This class is intended to track when the user is active and when they last demonstrated certain
  // forms of activity.  This is useful in a variety of scenarios:
  //
  // * You want to avoid sending a user an email when they're at their computer and a desktop
  //   notification will suffice.
  // * You don't want to update lists while the user is looking at them, because they might try to
  //   interact with a list item and hit the wrong one.
  //
  // Right now, the primary useful interface is idleTime().  In the future, we may add a way to
  // call code once idleTime reaches a certain number.
  constructor() {
    this._timeProvider = window.performance || Date;
    const now = this._timeProvider.now();
    this._lastFocusChangeTime = 0;
    this._lastMouseMoveTime = 0;
    this._lastClickTime = 0;
    this._lastKeyDownTime = 0;
    this._lastVisibilityChangeTime = now;
    this._lastScrollTime = 0;
    this._lastOtherActivityTime = 0;
    this._listeners = []; // A list of { callback, minIdleTimeMsec } objects

    window.addEventListener("focus", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastFocusChangeTime = now;
      this._notifyActivity(now - prevActivity);
    });

    window.addEventListener("blur", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastFocusChangeTime = now;
      this._notifyActivity(now - prevActivity);
    });

    window.addEventListener("mousemove", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastMouseMoveTime = now;
      this._notifyActivity(now - prevActivity);
    }, { capture: true });

    window.addEventListener("click", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastClickTime = now();
      this._notifyActivity(now - prevActivity);
    }, { capture: true });

    window.addEventListener("keydown", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastKeyDownTime = now;
      this._notifyActivity(now - prevActivity);
    }, { capture: true });

    window.addEventListener("visibilitychange", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastVisibilityChangeTime = now;
      this._notifyActivity(now - prevActivity);
    });

    window.addEventListener("scroll", (evt) => {
      const prevActivity = this._lastClearlyActive();
      const now = this._timeProvider.now();
      this._lastScrollTime = now;
      this._notifyActivity(now - prevActivity);
    }, { capture: true });
  }

  printStats() {
    const now = this._timeProvider.now();
    console.log("focus:     ", this._lastFocusChangeTime);
    console.log("mousemove: ", this._lastMouseMoveTime);
    console.log("click:     ", this._lastClickTime);
    console.log("keydown:   ", this._lastKeyDownTime);
    console.log("visiblity: ", this._lastVisibilityChangeTime);
    console.log("scroll:    ", this._lastScrollTime);
    console.log("other:     ", this._lastOtherActivityTime);
    console.log("now:       ", now);
    console.log("idletime:  ", now - this._lastClearlyActive());
  }

  markOtherActivity() {
    // A function that can be called when some other event demonstrates user interaction.
    // Initially, we'll use this for when users activate desktop notifications.
    const prevActivity = this._lastClearlyActive();
    const now = this._timeProvider.now();
    this._lastOtherActivityTime = now;
    this._notifyActivity(now - prevActivity);
  }

  _lastClearlyActive() {
    return Math.max(
      this._lastFocusChangeTime,
      this._lastMouseMoveTime,
      this._lastClickTime,
      this._lastKeyDownTime,
      this._lastVisibilityChangeTime,
      this._lastScrollTime,
      this._lastOtherActivityTime
    );
  }

  idleTime() {
    // Returns an upper bound on possible idle time in milliseconds
    return this._timeProvider.now() - this._lastClearlyActive();
  }

  _notifyActivity(prevIdleTime) {
    for (let i = 0; i < this._listeners.length; i++) {
      const listener = this._listeners[i];
      if (prevIdleTime > listener.minIdleTimeMsec) {
        listener.callback();
      }
    }
  }

  onReturnFromIdle(listener, minIdleTimeMsec) {
    // Requests that this activity tracker call listener() when observable activity occurs after at
    // least minIdleTimeMsec of nonactivity.
    this._listeners.push({
      callback: listener,
      minIdleTimeMsec,
    });
  }
}

export { ActivityTracker };
