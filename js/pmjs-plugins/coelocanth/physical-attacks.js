'use strict';

(function() {
  PMJS.phases.on('beforePlugins', 'pmjs.physical-attacks.parameters', function() {
    var load = PluginManager.loadScript;
    PluginManager.loadScript = function(name) {
      if (name !== 'physical_attack_animation.js') return load.apply(this, arguments);
      var source = NativeHost.fs.readText(this._path + name);
      if (!source || !globalThis.__pmjsBuiltinRequire ||
          __pmjsBuiltinRequire('crypto').createHash('sha256').update(source).digest('hex') !==
          '2c92521be28de34f1f01e382935a30a0d329708539d93b6256dbe4df25b52a93') return load.apply(this, arguments);
      // Repair only the reviewed parameter conversion; retain the action hook
      // and note-tag precedence authored by the installed script.
      source = source.replace("parameters('CC_physicalattacks')", "parameters('physical_attack_animation')")
        .replace('eval(String(parameters))', "(parameters.PhysicalAttacks === undefined || String(parameters.PhysicalAttacks).toLowerCase() === 'true')")
        .replace("String(parameters).split(' ')", "String(parameters.SkillTypes || '').trim().split(/\\s+/).filter(Boolean).map(Number)")
        .replace('types_weap = parseInt(types_weap);', 'types_weap[i] = parseInt(types_weap[i]);');
      return NativeHost.runtime.runScript(source);
    };
  });
})();
