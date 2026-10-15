'use strict';

(function() {
  if (typeof MvNativeWebAudio === 'undefined' || WebAudio !== MvNativeWebAudio) return;
  var prototype = WebAudio.prototype;
  var previous;
  var reviewed = {
    _load: '81b0d6d5161e713978225664945de969b65525b26d1cf5162d9f43638091b9eb',
    clear: '6c235331c0a98344be571c68d98bf38f2f11ff773edfdb72dbc5099af0af0a0c',
    isReady: 'c74ac96a12f4c5e0a5531a3f85422417f03adf2d712aee20e9a4801489f93bc6',
    isPlaying: 'fb786fad0f411038c7a4a18163e32eb217b01d81036eed6c135e43450409bfb0',
    play: '9c231ba0f41068aed148bd34af93afca488622a0042a9cbe59762841735c7ba5',
    stop: '809d2656665159e1d3d6faf0439a812df4fc9648578f08d28789313d8e661876',
    seek: '425761a8d1268e4e4f0a4437a6e2067d9ee074eff3522e84bfa91609081df404',
    pitchget: '16d7aab1a3cd264077696d31f20e72b2966faf3a1d64385cb03bc0c78dd407f1',
    pitchset: '1c07f6d983b1ea34d3a02a9ca6ea372b772ddfb37dff236eb43f1f6e351a784d',
    _onLoad: '01ca43a6f2e9c518129ff63d29b5b51a7a3c40a501c6f3e01214fd6b55aa07c6'
  };
  var streamingReview = {
    _load: '99caa79635f7f1830a6f06fe6fc5712171b3eb56ef4ed077888e7abdab1baf00',
    clear: '5f9c2ffa904accbc2edb93d7c943987068671bfd35d1fce73c19ea1e4041f586',
    isReady: 'fe331eec666b44fee2b33bf98a959771c79f816720e36390c11a73deaff58783',
    isPlaying: 'f4dd10eaf5b7405b99a5243511942c4e63afe26441634dfe68008128e2bd547e',
    play: '8a61f7ce64f08e5c0c882dbc0a1b063a6d4704ba205d12465b7f45217280b93b',
    stop: '4a932495a6f294248354cc911e5f3d4544eea7e6307f78cdcfd1b69d3306fd62',
    seek: 'cffcb54ee51cc1ae153f2bbe43ba8e201f9660b95a33f69b704558b7d5ab89d5',
    pitchget: 'f8e7df6e24a17f0ff08a6100d4991d110303cb52901b8dc97a2d80ba2ba87ae1',
    pitchset: 'a9e97372e64ea61761d42c13c14d48f2b0c3f0ed7ba0f8bba1389fa4f3e61088',
    _onLoad: '4280c09dfd91dd2fc5f8b683772644bcf6c61d761fef31c7417c7580d841dbe6'
  };
  var names = ['_load', 'clear', 'isReady', 'isPlaying', 'play', 'stop', 'seek', 'pitch', '_onLoad'];

  function matches(fn, fingerprint) {
    if (typeof fn !== 'function' || !globalThis.__pmjsBuiltinRequire) return false;
    var source = Function.prototype.toString.call(fn)
      .replace(/^(async )?function(?:\s+[\w$]+)?\s*\(/, '$1function(');
    return globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
      .update(source).digest('hex') === fingerprint;
  }

  function reviewedMethod(fn, name) {
    return matches(fn, reviewed[name]) || matches(fn, streamingReview[name]);
  }

  // Only this reviewed decoder script can request a helper before its method
  // replacements are installed. Delay that helper until native ownership is proved.
  var deferredHelpers = [], originalLoadScript = null;
  function flushHelpers() {
    var helpers = deferredHelpers.splice(0);
    helpers.forEach(function(name) { PluginManager.loadScript(name); });
  }

  PMJS.plugins.onLoading('AudioStreaming', 'pmjs.audio-streaming.native', function() {
    previous = {};
    names.forEach(function(name) {
      previous[name] = Object.getOwnPropertyDescriptor(prototype, name);
    });
    if (!NativeHost.fs || !globalThis.__pmjsBuiltinRequire || typeof PluginManager === 'undefined') return;
    var source = NativeHost.fs.readText('js/plugins/AudioStreaming.js');
    if (!source || globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256').update(source).digest('hex') !==
        'f921703e4d5f8c96f94bbf26af9bdc21d761987d3b39e0e7b71a461b29d5385b') return;
    originalLoadScript = PluginManager.loadScript;
    var load = originalLoadScript;
    PluginManager.loadScript = function(name) {
      if (name === 'stbvorbis_stream.js') { deferredHelpers.push(name); return; }
      try { return load.apply(this, arguments); }
      finally {
        PluginManager.loadScript = load;
        originalLoadScript = null;
      }
    };

  });

  PMJS.plugins.onLoaded('AudioStreaming', 'pmjs.audio-streaming.native', function() {
    if (!previous) return;
    if (originalLoadScript) { PluginManager.loadScript = originalLoadScript; originalLoadScript = null; }
    var changed = names.filter(function(name) {
      var before = previous[name];
      var after = Object.getOwnPropertyDescriptor(prototype, name);
      return !before || !after || before.value !== after.value ||
        before.get !== after.get || before.set !== after.set;
    });
    var unknown = changed.find(function(name) {
      var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      return !descriptor || !descriptor.configurable || !previous[name] ||
        (name === 'pitch' ? !reviewedMethod(descriptor.get, 'pitchget') ||
          !reviewedMethod(descriptor.set, 'pitchset') : !reviewedMethod(descriptor.value, name));
    });
    if (unknown) {
      PMJS.compat.hit('plugins.audio-streaming.voice', 'unrecognized ' + unknown + ' replacement');
      flushHelpers();
      return;
    }
    deferredHelpers.length = 0;
    // Restore the pre-plugin composition only for reviewed decoder overrides.
    // Routing, unchanged methods and later guest wrappers remain authored.
    changed.forEach(function(name) {
      Object.defineProperty(prototype, name, previous[name]);
    });
  });
})();
