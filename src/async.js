"use strict";
var firstLineError;
try {throw new Error(); } catch (e) {firstLineError = e;}
var ASSERT = require("./assert");
var schedule = require("./schedule");
var Queue = require("./queue");
var util = require("./util");

function Async() {
    this._isTickUsed = false;
    this._lateQueue = new Queue(LATE_QUEUE_CAPACITY);
    this._normalQueue = new Queue(NORMAL_QUEUE_CAPACITY);
    this._haveDrainedQueues = false;
    this._trampolineEnabled = true;
    var self = this;
    this.drainQueues = function () {
        self._drainQueues();
    };
    this._schedule =
        schedule.isStatic ? schedule(this.drainQueues) : schedule;
}

Async.prototype.disableTrampolineIfNecessary = function() {
    if (util.hasDevTools) {
        this._trampolineEnabled = false;
    }
};

Async.prototype.haveItemsQueued = function () {
    return this._isTickUsed || this._haveDrainedQueues;
};


Async.prototype.fatalError = function(e, isNode) {
    if (isNode) {
        process.stderr.write("Fatal " + (e instanceof Error ? e.stack : e));
        process.exit(2);
    } else {
        this.throwLater(e);
    }
};

// Must be used if fn can throw
Async.prototype.throwLater = function(fn, arg) {
    if (arguments.length === 1) {
        arg = fn;
        fn = function () { throw arg; };
    }
    var domain = this._getDomain();
    if (domain !== undefined) fn = domain.bind(fn);
    if (typeof setTimeout !== "undefined") {
        setTimeout(function() {
            fn(arg);
        }, 0);
    } else try {
        this._schedule(function() {
            fn(arg);
        });
    } catch (e) {
        throw new Error(NO_ASYNC_SCHEDULER);
    }
};

Async.prototype._getDomain = function() {};

if (!__BROWSER__) {
if (util.isNode) {
    var EventsModule = require("events");

    var domainGetter = function() {
        var domain = process.domain;
        if (domain === null) return undefined;
        return domain;
    };

    if (EventsModule.usingDomains) {
        Async.prototype._getDomain = domainGetter;
    } else {
        var descriptor =
            Object.getOwnPropertyDescriptor(EventsModule, "usingDomains");

        if (descriptor) {
            if (!descriptor.configurable) {
                process.on("domainsActivated", function() {
                    Async.prototype._getDomain = domainGetter;
                });
            } else {
                var usingDomains = false;
                Object.defineProperty(EventsModule, "usingDomains", {
                    configurable: false,
                    enumerable: true,
                    get: function() {
                        return usingDomains;
                    },
                    set: function(value) {
                        if (usingDomains || !value) return;
                        usingDomains = true;
                        Async.prototype._getDomain = domainGetter;
                        // Node doesn't do this themselves unfortunately.
                        util.toFastProperties(process);
                        process.emit("domainsActivated");
                    }
                });
            }
        }
    }
}
}

//When the fn absolutely needs to be called after
//the queue has been completely flushed
function AsyncInvokeLater(fn, receiver, arg) {
    ASSERT(arguments.length === 3);
    var domain = this._getDomain();
    if (domain !== undefined) fn = domain.bind(fn);
    this._lateQueue.push(fn, receiver, arg);
    this._queueTick();
}

function AsyncInvoke(fn, receiver, arg) {
    ASSERT(arguments.length === 3);
    var domain = this._getDomain();
    if (domain !== undefined) fn = domain.bind(fn);
    this._normalQueue.push(fn, receiver, arg);
    this._queueTick();
}

function AsyncSettlePromises(promise) {
    var domain = this._getDomain();
    if (domain !== undefined) {
        var fn = domain.bind(promise._settlePromises);
        this._normalQueue.push(fn, promise, undefined);
    } else {
        this._normalQueue._pushOne(promise);
    }
    this._queueTick();
}

if (!util.hasDevTools) {
    Async.prototype.invokeLater = AsyncInvokeLater;
    Async.prototype.invoke = AsyncInvoke;
    Async.prototype.settlePromises = AsyncSettlePromises;
} else {
    if (schedule.isStatic) {
        schedule = function(fn) { setTimeout(fn, 0); };
    }
    Async.prototype.invokeLater = function (fn, receiver, arg) {
        if (this._trampolineEnabled) {
            AsyncInvokeLater.call(this, fn, receiver, arg);
        } else {
            this._schedule(function() {
                setTimeout(function() {
                    fn.call(receiver, arg);
                }, 100);
            });
        }
    };

    Async.prototype.invoke = function (fn, receiver, arg) {
        if (this._trampolineEnabled) {
            AsyncInvoke.call(this, fn, receiver, arg);
        } else {
            this._schedule(function() {
                fn.call(receiver, arg);
            });
        }
    };

    Async.prototype.settlePromises = function(promise) {
        if (this._trampolineEnabled) {
            AsyncSettlePromises.call(this, promise);
        } else {
            this._schedule(function() {
                promise._settlePromises();
            });
        }
    };
}

Async.prototype.invokeFirst = function (fn, receiver, arg) {
    ASSERT(arguments.length === 3);
    var domain = this._getDomain();
    if (domain !== undefined) fn = domain.bind(fn);
    this._normalQueue.unshift(fn, receiver, arg);
    this._queueTick();
};

Async.prototype._drainQueue = function(queue) {
    while (queue.length() > 0) {
        var fn = queue.shift();
        if (typeof fn !== "function") {
            fn._settlePromises();
            continue;
        }
        var receiver = queue.shift();
        var arg = queue.shift();
        fn.call(receiver, arg);
    }
};

Async.prototype._drainQueues = function () {
    ASSERT(this._isTickUsed);
    this._drainQueue(this._normalQueue);
    this._reset();
    this._haveDrainedQueues = true;
    this._drainQueue(this._lateQueue);
};

Async.prototype._queueTick = function () {
    if (!this._isTickUsed) {
        this._isTickUsed = true;
        this._schedule(this.drainQueues);
    }
};

Async.prototype._reset = function () {
    this._isTickUsed = false;
};

module.exports = Async;
module.exports.firstLineError = firstLineError;
