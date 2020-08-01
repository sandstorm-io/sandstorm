// Typically, Meteor binds to one port and speaks HTTP.
//
// For Sandstorm, `run-bundle` has already bound a number of TCP ports
// for us and passed them in as file descriptors starting at #3. So
// this file runs before Meteor starts, monkey-patching the node world
// so that, along with pre-meteor.js, we create the the right
// HTTP+HTTPS services.

var http = require('http');
var net = require('net');

var isDevShellMode = process.argv.length > 2;

var firstInheritedFd = isDevShellMode ? 65 : 3;

function sandstormMain() {
  process.env.SANDSTORM_SMTP_LISTEN_HANDLE = (firstInheritedFd + 2).toString();
  process.env.SANDSTORM_BACKEND_HANDLE = (firstInheritedFd + 1).toString();
  monkeypatchHttpForGateway();

  if (isDevShellMode) {
    // Cut ourselves out of argv.
    process.argv = [process.argv[0]].concat(process.argv.slice(2));

    // Change to the shell directory, which Meteor expects.
    process.chdir("shell");

    // Delegate to Meteor dev tool.
    require(process.argv[1]);
  } else {
    // Delegate to Meteor runtime.
    require("./main.js");
  }
}

function monkeypatchHttpForGateway() {
  // Monkey-patch the HTTP server module to receive connections over a unix socket on FD 3 instead
  // of listening the usual way.

  if (process.env.HTTP_GATEWAY === "local") {
    // Node.js has no public API for receiving file descriptors via SCM_RIGHTS on a unix pipe.
    // However, it does have a *private* API for this, which it uses to implement child_process.
    // We use the private API here. This could break when we update Node. If so, that's our fault.
    // But we pin our Node version, so this should be easy to control. Also, this interface hasn't
    // changed in forever.
    const { Pipe, constants: PipeConstants } = process.binding('pipe_wrap');

    global.sandstormListenCapabilityStream = function (fd, cb) {
      var pipe = new Pipe(PipeConstants.IPC);
      pipe.open(fd);
      pipe.onread = function (buf) {
        let handle = pipe.pendingHandle;
        if (handle) {
          pipe.pendingHandle = null;
          cb(new net.Socket({ handle: handle, readable: true, writable: true }));
        }
      };
      pipe.readStart();
    }
  }

  var oldListen = http.Server.prototype.listen;
  var alreadyListened = false;
  http.Server.prototype.listen = function (port, host, cb) {
    if (port.toString() === process.env.PORT ||
        (typeof port === "object" && port.port && port.port.toString() === process.env.PORT)) {
      // Attempt to listen on the HTTP port. Override.
      if (alreadyListened) {
        throw new Error("can only listen on primary HTTP port once");
      }
      alreadyListened = true;

      if (process.env.HTTP_GATEWAY === "local") {
        // Gateway running locally, connecting over unix socketpair via SCM_RIGHTS transfer.
        global.sandstormListenCapabilityStream(firstInheritedFd, socket => {
          this.emit("connection", socket);
        });
        (cb || host)();
      } else {
        // Gateway running remotely, connecting over a regular socket.
        oldListen.call(this, { fd: firstInheritedFd }, cb || host);
      }
    } else {
      // Don't override.
      return oldListen.call(this, port, host, cb);
    }
  }
}

sandstormMain();
