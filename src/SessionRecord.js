/*
 * vim: ts=4:sw=4
 */

var Internal = Internal || {};

Internal.BaseKeyType = {
  OURS: 1,
  THEIRS: 2
};
Internal.ChainType = {
  SENDING: 1,
  RECEIVING: 2
};

Internal.SessionRecord = function() {
    'use strict';
    var ARCHIVED_STATES_MAX_LENGTH = 40;
    var SESSION_RECORD_VERSION = 'v1';

    var StaticByteBufferProto = new dcodeIO.ByteBuffer().__proto__;
    var StaticArrayBufferProto = new ArrayBuffer().__proto__;
    var StaticUint8ArrayProto = new Uint8Array().__proto__;

    function isStringable(thing) {
        return (thing === Object(thing) &&
                (thing.__proto__ == StaticArrayBufferProto ||
                    thing.__proto__ == StaticUint8ArrayProto ||
                    thing.__proto__ == StaticByteBufferProto));
    }
    function ensureStringed(thing) {
        if (typeof thing == "string" || typeof thing == "number" || typeof thing == "boolean") {
            return thing;
        } else if (isStringable(thing)) {
            return util.toString(thing);
        } else if (thing instanceof Array) {
            var array = [];
            for (var i = 0; i < thing.length; i++) {
                array[i] = ensureStringed(thing[i]);
            }
            return array;
        } else if (thing === Object(thing)) {
            var obj = {};
            for (var key in thing) {
                try {
                  obj[key] = ensureStringed(thing[key]);
                } catch (ex) {
                  console.log('Error serializing key', key);
                  throw ex;
                }
            }
            return obj;
        } else if (thing === null) {
            return null;
        } else {
            throw new Error("unsure of how to jsonify object of type " + typeof thing);
        }
    }

    function jsonThing(thing) {
        return JSON.stringify(ensureStringed(thing)); //TODO: jquery???
    }

    var migrations = [
      {
        version: 'v1',
        migrate: function migrateV1(data) {
          var sessions = data.sessions;
          var key;
          if (data.registrationId) {
              for (key in sessions) {
                  if (!sessions[key].registrationId) {
                      sessions[key].registrationId = data.registrationId;
                  }
              }
          } else {
              for (key in sessions) {
                  if (sessions[key].indexInfo.closed === -1) {
                      console.log('V1 session storage migration error: registrationId',
                          data.registrationId, 'for open session version',
                          data.version);
                  }
              }
          }
        }
      }
    ];

    function migrate(data) {
      var run = (data.version === undefined);
      for (var i=0; i < migrations.length; ++i) {
        if (run) {
          migrations[i].migrate(data);
        } else if (migrations[i].version === data.version) {
          run = true;
        }
      }
      if (!run) {
        throw new Error("Error migrating SessionRecord");
      }
    }

    var SessionRecord = function() {
        this._sessions = {};
        this.version = SESSION_RECORD_VERSION;
    };

    SessionRecord.deserialize = function(serialized) {
        var data = JSON.parse(serialized);
        if (data.version !== SESSION_RECORD_VERSION) { migrate(data); }

        var record = new SessionRecord();
        record._sessions = data.sessions;
        if (record._sessions === undefined || record._sessions === null || typeof record._sessions !== "object" || Array.isArray(record._sessions)) {
            throw new Error("Error deserializing SessionRecord");
        }
        return record;
    };

    SessionRecord.prototype = {
        serialize: function() {
            return jsonThing({
                sessions       : this._sessions,
                version        : this.version
            });
        },
        haveOpenSession: function() {
            var openSession = this.getOpenSession();
            return (!!openSession && !!openSession.registrationId);
        },

        getSessionByBaseKey: function(baseKey) {
            var session = this._sessions[util.toString(baseKey)];
            if (session && session.indexInfo.baseKeyType === Internal.BaseKeyType.OURS) {
                console.log("Tried to lookup a session using our basekey");
                return undefined;
            }
            return session;
        },
        getSessionByRemoteEphemeralKey: function(remoteEphemeralKey) {
            this.detectDuplicateOpenSessions();
            var sessions = this._sessions;

            var searchKey = util.toString(remoteEphemeralKey);

            var openSession;
            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    openSession = sessions[key];
                }
                if (sessions[key][searchKey] !== undefined) {
                    return sessions[key];
                }
            }
            if (openSession !== undefined) {
                return openSession;
            }

            return undefined;
        },
        getOpenSession: function() {
            var sessions = this._sessions;
            if (sessions === undefined) {
                return undefined;
            }

            this.detectDuplicateOpenSessions();

            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    return sessions[key];
                }
            }
            return undefined;
        },
        detectDuplicateOpenSessions: function() {
            var openSession;
            var sessions = this._sessions;
            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    if (openSession !== undefined) {
                        throw new Error("Datastore inconsistensy: multiple open sessions");
                    }
                    openSession = sessions[key];
                }
            }
        },
        updateSessionState: function(session) {
            var sessions = this._sessions;

            this.removeOldChains(session);

            sessions[util.toString(session.indexInfo.baseKey)] = session;

            this.removeOldSessions();

        },
        getSessions: function() {
            // return an array of sessions ordered by time closed,
            // followed by the open session
            var list = [];
            var openSession;
            for (var k in this._sessions) {
                if (this._sessions[k].indexInfo.closed === -1) {
                    openSession = this._sessions[k];
                } else {
                    list.push(this._sessions[k]);
                }
            }
            list = list.sort(function(s1, s2) {
                return s1.indexInfo.closed - s2.indexInfo.closed;
            });
            if (openSession) {
                list.push(openSession);
            }
            return list;
        },
        archiveCurrentState: function() {
            var open_session = this.getOpenSession();
            if (open_session !== undefined) {
                this.closeSession(open_session);
                this.updateSessionState(open_session);
            }
        },
        closeSession: function(session) {
            if (session.indexInfo.closed > -1) {
                return;
            }
            console.log('closing session', session.indexInfo.baseKey);

            // After this has run, we can still receive messages on ratchet chains which
            // were already open (unless we know we dont need them),
            // but we cannot send messages or step the ratchet

            // Delete current sending ratchet
            delete session[util.toString(session.currentRatchet.ephemeralKeyPair.pubKey)];
            // Move all receive ratchets to the oldRatchetList to mark them for deletion
            for (var i in session) {
                if (session[i].chainKey !== undefined && session[i].chainKey.key !== undefined) {
                    session.oldRatchetList[session.oldRatchetList.length] = {
                        added: Date.now(), ephemeralKey: i
                    };
                }
            }
            session.indexInfo.closed = Date.now();
            this.removeOldChains(session);
        },
        removeOldChains: function(session) {
            // Sending ratchets are always removed when we step because we never need them again
            // Receiving ratchets are added to the oldRatchetList, which we parse
            // here and remove all but the last five.
            while (session.oldRatchetList.length > 5) {
                var index = 0;
                var oldest = session.oldRatchetList[0];
                for (var i = 0; i < session.oldRatchetList.length; i++) {
                    if (session.oldRatchetList[i].added < oldest.added) {
                        oldest = session.oldRatchetList[i];
                        index = i;
                    }
                }
                console.log("Deleting chain closed at", oldest.added);
                delete session[util.toString(oldest.ephemeralKey)];
                session.oldRatchetList.splice(index, 1);
            }
        },
        removeOldSessions: function() {
            // Retain only the last 20 sessions
            var sessions = this._sessions;
            var oldestBaseKey, oldestSession;
            while (Object.keys(sessions).length > ARCHIVED_STATES_MAX_LENGTH) {
                for (var key in sessions) {
                    var session = sessions[key];
                    if (session.indexInfo.closed > -1 && // session is closed
                        (!oldestSession || session.indexInfo.closed < oldestSession.indexInfo.closed)) {
                        oldestBaseKey = key;
                        oldestSession = session;
                    }
                }
                console.log("Deleting session closed at", oldestSession.indexInfo.closed);
                delete sessions[util.toString(oldestBaseKey)];
            }
        },
    };

    return SessionRecord;
}();
