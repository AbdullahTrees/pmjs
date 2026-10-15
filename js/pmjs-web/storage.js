var storageValues = Object.create(null);
function webStoragePath(key) {
  return 'web-storage/' + encodeURIComponent(String(key));
}
globalThis.localStorage = {
  getItem: function(key) {
    if (NativeHost.storage) return NativeHost.storage.readText(webStoragePath(key));
    return Object.prototype.hasOwnProperty.call(storageValues, key) ? storageValues[key] : null;
  },
  setItem: function(key, value) {
    if (NativeHost.storage) NativeHost.storage.writeText(webStoragePath(key), String(value));
    else storageValues[key] = String(value);
  },
  removeItem: function(key) {
    if (NativeHost.storage) NativeHost.storage.remove(webStoragePath(key));
    else delete storageValues[key];
  },
  clear: function() {
    if (NativeHost.storage) {
      var entries = NativeHost.storage.readDirectory('web-storage');
      if (entries) {
        for (var index = 0; index < entries.length; index++) {
          NativeHost.storage.remove('web-storage/' + entries[index]);
        }
      }
    } else {
      storageValues = Object.create(null);
    }
  }
};

// Session data belongs to this guest instance and is discarded on restart.
var sessionValues = Object.create(null);
globalThis.sessionStorage = {
  get length() { return Object.keys(sessionValues).length; },
  key: function(index) { return Object.keys(sessionValues)[Number(index) >>> 0] || null; },
  getItem: function(key) {
    key = String(key);
    return Object.prototype.hasOwnProperty.call(sessionValues, key) ? sessionValues[key] : null;
  },
  setItem: function(key, value) { sessionValues[String(key)] = String(value); },
  removeItem: function(key) { delete sessionValues[String(key)]; },
  clear: function() { sessionValues = Object.create(null); }
};
