var Socket = require('net').Socket;
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var readUInt32BE = require('./buffer-helpers').readUInt32BE;
var writeUInt32BE = require('./buffer-helpers').writeUInt32BE;
var writeUInt32LE = require('./buffer-helpers').writeUInt32LE;

var REQUEST_IDENTITIES = 11;
var IDENTITIES_ANSWER = 12;
var SIGN_REQUEST = 13;
var SIGN_RESPONSE = 14;
var FAILURE = 5;

var RE_CYGWIN_SOCK = /^\!<socket >(\d+) s ([A-Z0-9]{8}\-[A-Z0-9]{8}\-[A-Z0-9]{8}\-[A-Z0-9]{8})/;

// Format of `//./pipe/ANYTHING`, with forward slashes and backward slashes being interchangeable
var WINDOWS_PIPE_REGEX = /^[/\\][/\\]\.[/\\]pipe[/\\].+/;

module.exports = function(sockPath, key, keyType, data, cb) {
  var sock;
  var error;
  var sig;
  var datalen;
  var keylen = 0;
  var isSigning = Buffer.isBuffer(key);
  var type;
  var count = 0;
  var siglen = 0;
  var nkeys = 0;
  var keys;
  var comlen = 0;
  var comment = false;
  var accept;
  var reject;

  if (typeof key === 'function' && typeof keyType === 'function') {
    // agent forwarding
    accept = key;
    reject = keyType;
  } else if (isSigning) {
    keylen = key.length;
    datalen = data.length;
  } else {
    cb = key;
    key = undefined;
  }

  function onconnect() {
    var buf;
    if (isSigning) {
      /*
        byte        SSH2_AGENTC_SIGN_REQUEST
        string      key_blob
        string      data
        uint32      flags
      */
      var p = 9;
      buf = Buffer.allocUnsafe(4 + 1 + 4 + keylen + 4 + datalen + 4);
      writeUInt32BE(buf, buf.length - 4, 0);
      buf[4] = SIGN_REQUEST;
      writeUInt32BE(buf, keylen, 5);
      key.copy(buf, p);
      writeUInt32BE(buf, datalen, p += keylen);
      data.copy(buf, p += 4);
      writeUInt32BE(buf, 0, p += datalen);
      sock.write(buf);
    } else {
      /*
        byte        SSH2_AGENTC_REQUEST_IDENTITIES
      */
      sock.write(Buffer.from([0, 0, 0, 1, REQUEST_IDENTITIES]));
    }
  }
  function ondata(chunk) {
    for (var i = 0, len = chunk.length; i < len; ++i) {
      if (type === undefined) {
        // skip over packet length
        if (++count === 5) {
          type = chunk[i];
          count = 0;
        }
      } else if (type === SIGN_RESPONSE) {
        /*
          byte        SSH2_AGENT_SIGN_RESPONSE
          string      signature_blob
        */
        if (!sig) {
          siglen <<= 8;
          siglen += chunk[i];
          if (++count === 4) {
            sig = Buffer.allocUnsafe(siglen);
            count = 0;
          }
        } else {
          sig[count] = chunk[i];
          if (++count === siglen) {
            sock.removeAllListeners('data');
            return sock.destroy();
          }
        }
      } else if (type === IDENTITIES_ANSWER) {
        /*
          byte        SSH2_AGENT_IDENTITIES_ANSWER
          uint32      num_keys

        Followed by zero or more consecutive keys, encoded as:

          string      public key blob
          string      public key comment
        */
        if (keys === undefined) {
          nkeys <<= 8;
          nkeys += chunk[i];
          if (++count === 4) {
            keys = new Array(nkeys);
            count = 0;
            if (nkeys === 0) {
              sock.removeAllListeners('data');
              return sock.destroy();
            }
          }
        } else {
          if (!key) {
            keylen <<= 8;
            keylen += chunk[i];
            if (++count === 4) {
              key = Buffer.allocUnsafe(keylen);
              count = 0;
            }
          } else if (comment === false) {
            key[count] = chunk[i];
            if (++count === keylen) {
              keys[nkeys - 1] = key;
              keylen = 0;
              count = 0;
              comment = true;
              if (--nkeys === 0) {
                key = undefined;
                sock.removeAllListeners('data');
                return sock.destroy();
              }
            }
          } else if (comment === true) {
            comlen <<= 8;
            comlen += chunk[i];
            if (++count === 4) {
              count = 0;
              if (comlen > 0)
                comment = comlen;
              else {
                key = undefined;
                comment = false;
              }
              comlen = 0;
            }
          } else {
            // skip comments
            if (++count === comment) {
              comment = false;
              count = 0;
              key = undefined;
            }
          }
        }
      } else if (type === FAILURE) {
        if (isSigning)
          error = new Error('Agent unable to sign data');
        else
          error = new Error('Unable to retrieve list of keys from agent');
        sock.removeAllListeners('data');
        return sock.destroy();
      }
    }
  }
  function onerror(err) {
    error = err;
  }
  function onclose() {
    if (error)
      cb(error);
    else if ((isSigning && !sig) || (!isSigning && !keys))
      cb(new Error('Unexpected disconnection from agent'));
    else if (isSigning && sig)
      cb(undefined, sig);
    else if (!isSigning && keys)
      cb(undefined, keys);
  }

  if (process.platform === 'win32' && !WINDOWS_PIPE_REGEX.test(sockPath)) {
    if (sockPath === 'pageant') {
      // Pageant (PuTTY authentication agent)
      sock = new PageantSock();
    } else {
      // cygwin ssh-agent instance
      var triedCygpath = false;
      fs.readFile(sockPath, function readCygsocket(err, data) {
        if (err) {
          if (triedCygpath)
            return cb(new Error('Invalid cygwin unix socket path'));
          // try using `cygpath` to convert a possible *nix-style path to the
          // real Windows path before giving up ...
          cp.exec('cygpath -w "' + sockPath + '"',
                  function(err, stdout, stderr) {
            if (err || stdout.length === 0)
              return cb(new Error('Invalid cygwin unix socket path'));
            triedCygpath = true;
            sockPath = stdout.toString().replace(/[\r\n]/g, '');
            fs.readFile(sockPath, readCygsocket);
          });
          return;
        }

        var m;
        if (m = RE_CYGWIN_SOCK.exec(data.toString('ascii'))) {
          var port;
          var secret;
          var secretbuf;
          var state;
          var bc = 0;
          var isRetrying = false;
          var inbuf = [];
          var credsbuf = Buffer.allocUnsafe(12);
          var i;
          var j;

          // use 0 for pid, uid, and gid to ensure we get an error and also
          // a valid uid and gid from cygwin so that we don't have to figure it
          // out ourselves
          credsbuf.fill(0);

          // parse cygwin unix socket file contents
          port = parseInt(m[1], 10);
          secret = m[2].replace(/\-/g, '');
          secretbuf = Buffer.allocUnsafe(16);
          for (i = 0, j = 0; j < 32; ++i,j+=2)
            secretbuf[i] = parseInt(secret.substring(j, j + 2), 16);

          // convert to host order (always LE for Windows)
          for (i = 0; i < 16; i += 4)
            writeUInt32LE(secretbuf, readUInt32BE(secretbuf, i), i);

          function _onconnect() {
            bc = 0;
            state = 'secret';
            sock.write(secretbuf);
          }
          function _ondata(data) {
            bc += data.length;
            if (state === 'secret') {
              // the secret we sent is echoed back to us by cygwin, not sure of
              // the reason for that, but we ignore it nonetheless ...
              if (bc === 16) {
                bc = 0;
                state = 'creds';
                sock.write(credsbuf);
              }
            } else if (state === 'creds') {
              // if this is the first attempt, make sure to gather the valid
              // uid and gid for our next attempt
              if (!isRetrying)
                inbuf.push(data);

              if (bc === 12) {
                sock.removeListener('connect', _onconnect);
                sock.removeListener('data', _ondata);
                sock.removeListener('close', _onclose);
                if (isRetrying) {
                  addSockListeners();
                  sock.emit('connect');
                } else {
                  isRetrying = true;
                  credsbuf = Buffer.concat(inbuf);
                  writeUInt32LE(credsbuf, process.pid, 0);
                  sock.destroy();
                  tryConnect();
                }
              }
            }
          }
          function _onclose() {
            cb(new Error('Problem negotiating cygwin unix socket security'));
          }
          function tryConnect() {
            sock = new Socket();
            sock.once('connect', _onconnect);
            sock.on('data', _ondata);
            sock.once('close', _onclose);
            sock.connect(port);
          }
          tryConnect();
        } else
          cb(new Error('Malformed cygwin unix socket file'));
      });
      return;
    }
  } else
    sock = new Socket();

  function addSockListeners() {
    if (!accept && !reject) {
      sock.once('connect', onconnect);
      sock.on('data', ondata);
      sock.once('error', onerror);
      sock.once('close', onclose);
    } else {
      var chan;
      sock.once('connect', function() {
        chan = accept();
        var isDone = false;
        function onDone() {
          if (isDone)
            return;
          sock.destroy();
          isDone = true;
        }
        chan.once('end', onDone)
            .once('close', onDone)
            .on('data', function(data) {
          sock.write(data);
        });
        sock.on('data', function(data) {
          chan.write(data);
        });
      });
      sock.once('close', function() {
        if (!chan)
          reject();
      });
    }
  }
  addSockListeners();
  sock.connect(sockPath);
};


// win32 only ------------------------------------------------------------------
if (process.platform === 'win32') {
  var RET_ERR_BADARGS = 10;
  var RET_ERR_UNAVAILABLE = 11;
  var RET_ERR_NOMAP = 12;
  var RET_ERR_BINSTDIN = 13;
  var RET_ERR_BINSTDOUT = 14;
  var RET_ERR_BADLEN = 15;

  var ERROR = {};
  var EXEPATH = path.resolve(__dirname, '..', 'util/pagent.exe');
  ERROR[RET_ERR_BADARGS] = new Error('Invalid pagent.exe arguments');
  ERROR[RET_ERR_UNAVAILABLE] = new Error('Pageant is not running');
  ERROR[RET_ERR_NOMAP] = new Error('pagent.exe could not create an mmap');
  ERROR[RET_ERR_BINSTDIN] = new Error('pagent.exe could not set mode for stdin');
  ERROR[RET_ERR_BINSTDOUT] = new Error('pagent.exe could not set mode for stdout');
  ERROR[RET_ERR_BADLEN] = new Error('pagent.exe did not get expected input payload');

  function PageantSock() {
    this.proc = undefined;
    this.buffer = null;
  }
  inherits(PageantSock, EventEmitter);

  PageantSock.prototype.write = function(buf) {
    if (this.buffer === null)
      this.buffer = buf;
    else {
      this.buffer = Buffer.concat([this.buffer, buf],
                                  this.buffer.length + buf.length);
    }
    // Wait for at least all length bytes
    if (this.buffer.length < 4)
      return;

    var len = readUInt32BE(this.buffer, 0);
    // Make sure we have a full message before querying pageant
    if ((this.buffer.length - 4) < len)
      return;

    buf = this.buffer.slice(0, 4 + len);
    if (this.buffer.length > (4 + len))
      this.buffer = this.buffer.slice(4 + len);
    else
      this.buffer = null;

    var self = this;
    var proc;
    var hadError = false;
    proc = this.proc = cp.spawn(EXEPATH, [ buf.length ]);
    proc.stdout.on('data', function(data) {
      self.emit('data', data);
    });
    proc.once('error', function(err) {
      if (!hadError) {
        hadError = true;
        self.emit('error', err);
      }
    });
    proc.once('close', function(code) {
      self.proc = undefined;
      if (ERROR[code] && !hadError) {
        hadError = true;
        self.emit('error', ERROR[code]);
      }
      self.emit('close', hadError);
    });
    proc.stdin.end(buf);
  };
  PageantSock.prototype.end = PageantSock.prototype.destroy = function() {
    this.buffer = null;
    if (this.proc) {
      this.proc.kill();
      this.proc = undefined;
    }
  };
  PageantSock.prototype.connect = function() {
    this.emit('connect');
  };
}
