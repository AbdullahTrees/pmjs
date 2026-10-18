(function() {
  var rendererPlugins = PIXI.WebGLRenderer &&
    PIXI.WebGLRenderer.__plugins || {};
  var baselinePlugins = Object.assign({}, rendererPlugins);
  var knownClasses = {
    ShaderTilemap: globalThis.ShaderTilemap,
    WindowLayer: globalThis.WindowLayer,
    ToneSprite: globalThis.ToneSprite,
    ScreenSprite: globalThis.ScreenSprite,
    MVTilingSprite: globalThis.TilingSprite,
    MVSprite: globalThis.Sprite,
    Window: globalThis.Window,
    Tilemap: globalThis.Tilemap,
    Weather: globalThis.Weather,
    Stage: globalThis.Stage,
    PictureTilingSprite: PIXI.extras && PIXI.extras.PictureTilingSprite,
    TilingSprite: PIXI.extras && PIXI.extras.TilingSprite,
    BitmapText: PIXI.extras && PIXI.extras.BitmapText,
    Text: PIXI.Text,
    RectTileLayer: PIXI.tilemap && PIXI.tilemap.RectTileLayer,
    CompositeRectTileLayer: PIXI.tilemap && PIXI.tilemap.CompositeRectTileLayer,
    ParticleContainer: PIXI.particles && PIXI.particles.ParticleContainer,
    Mesh: PIXI.mesh && PIXI.mesh.Mesh,
    Graphics: PIXI.Graphics,
    Sprite: PIXI.Sprite,
    Container: PIXI.Container,
    DisplayObject: PIXI.DisplayObject
  };
  var renderMethods = ['renderWebGL', '_renderWebGL',
    'renderCanvas', '_renderCanvas'];
  var classNames = Object.keys(knownClasses);

  var baselineMethods = {};
  // Reviewed Pixi 4.8.9 / MV 1.6.1 transforms; LF and CRLF are pinned separately.
  var reviewedTransforms = {
    '1a091756d85883232da57aa53141f43968c21abfc58b6b231a46c0faa9014861': 'container',
    'f611889101e9659a0c13ef6cdfa1b6a0be5edb374a52ad864169ddf6976d9a8e': 'leaf',
    '82e01e278fa992ea039746f47f6a00d322d7d4eb4de96042ab43a243f90abfb5': 'Window',
    'cfcbeacef1f4ca9ed869519fdba23e734e6e70e75bce5b05bb75718e6fea548a': 'Window',
    '157efc2a1a0d853d5b1a73253fb03d8e341262a186b777058e2477f94d38699e': 'Tilemap',
    '2169c8e4be4708d97d9be182006b653aa0fcdb74dd7c1cf1270b1dd4f3963e48': 'Tilemap',
    'b7a7a370946ce0ae21b0627c85c55abd0efd8db9eef430a0afcb92f37637f236': 'ShaderTilemap',
    '0b7ff0daca0957e3b83d04114304eb6263ab76da0275136f9361ad02b06bbde6': 'ShaderTilemap',
    '4f9a4db6586f0c4e6ea136575dfbfee6777ab55ee74cc963ee45a2d6f33274b0': 'MVTilingSprite',
    '387766129c695c855bf5a624b0dd29893b5188d97f812d310ff6a7aa41979f8a': 'MVTilingSprite',
    'abd83186c0164ab387381fbfd697391e57686aa3c68696fa1256d6cc0cd64b55': 'tileLeaf',
    '0938d1a3fcf18a6628689547f09640615c0b7a096e445b869559d2e3a6ecaa4f': 'tileLeaf'
  };
  var containerClass = PIXI.Container;
  var displayObjectTransform = PIXI.DisplayObject && PIXI.DisplayObject.prototype.updateTransform;
  var containerTransform = PIXI.Container && PIXI.Container.prototype.updateTransform;
  var tilingTransform = globalThis.TilingSprite && TilingSprite.prototype.updateTransformTS;
  function reviewedTransform(method) {
    var digest = Object.keys(reviewedTransforms).find(function(expected) {
      return PMJS.methods.matchesSource(method, expected);
    });
    return reviewedTransforms[digest];
  }
  var transformEquivalents = new Map();
  var renderTransformChecks = [];
  var cachedTransformEntries = new WeakMap();
  var baselineWebGLMethods = new WeakMap();
  var cachedWebGL = PIXI.DisplayObject &&
    PIXI.DisplayObject.prototype._renderCachedWebGL;
  var emptyMethods = {};
  classNames.forEach(function(name) {
    var proto = knownClasses[name] && knownClasses[name].prototype;
    if (!proto) return;
    baselineWebGLMethods.set(proto, {
      renderWebGL: proto.renderWebGL,
      _renderWebGL: proto._renderWebGL,
      // These stock entry points draw directly without dispatching the leaf hook.
      callsLeaf: name !== 'WindowLayer' && name !== 'ParticleContainer' &&
        name !== 'RectTileLayer' && name !== 'CompositeRectTileLayer'
    });
    baselineMethods[name] = {};
    var transformMethod = proto.updateTransform;
    var transformKind = reviewedTransform(transformMethod);
    if (transformKind && !transformEquivalents.has(transformMethod)) {
      transformEquivalents.set(transformMethod, { kind: transformKind === 'tileLeaf' ? 'leaf' : transformKind,
        verify: transformKind === 'container' || transformKind === 'leaf' ? null : function(node) {
          return PIXI.Container.prototype.updateTransform === containerTransform &&
            (transformKind !== 'MVTilingSprite' || node.updateTransformTS === tilingTransform &&
              transformEquivalents.has(tilingTransform)) &&
            (transformKind !== 'tileLeaf' ||
              containerClass.prototype.displayObjectUpdateTransform === displayObjectTransform);
        } });
    }
    renderMethods.forEach(function(method) {
      baselineMethods[name][method] =
        Object.prototype.hasOwnProperty.call(proto, method) ? proto[method] :
          undefined;
    });
  });

  function unsupportedMethod(node) {
    var proto = Object.getPrototypeOf(node);
    var baseline;
    while (proto && !(baseline = baselineWebGLMethods.get(proto))) {
      proto = Object.getPrototypeOf(proto);
    }
    baseline = baseline || emptyMethods;
    var renderWebGL = node.renderWebGL;
    if (cachedWebGL && node._cacheAsBitmap && renderWebGL === cachedWebGL) {
      // A realized cache draws its snapshot, not the original node's hooks.
      if (!node.__pmjsBuildingBitmapCache && node._cacheData &&
          node._cacheData.sprite) return null;
      renderWebGL = node._cacheData && node._cacheData.originalRenderWebGL;
    }
    if (renderWebGL !== baseline.renderWebGL) return 'renderWebGL';
    if (baseline.callsLeaf !== false &&
        node._renderWebGL !== baseline._renderWebGL) return '_renderWebGL';
    return null;
  }

  function check(node) {
    var method = unsupportedMethod(node);
    if (method) {
      PMJS.compat.hit('render.render-method',
        (node.constructor && node.constructor.name || 'node') + '.' + method);
    }
  }

  function transformPlan(stage) {
    var entries = new WeakMap();
    function visit(node) {
      if (!node) return 0;
      var method = node.updateTransform;
      var equivalent = transformEquivalents.get(method);
      if (!equivalent || equivalent.verify && !equivalent.verify(node) ||
          !node.transform || typeof node.transform.updateTransform !== 'function') return -1;
      var nativePreparation = !!equivalent.prepare || equivalent.kind === 'Tilemap' || equivalent.kind === 'ShaderTilemap';
      if (equivalent.kind === 'leaf') return 0;
      var children = node.children || [];
      for (var index = 0; index < children.length; index++) {
        if (!children[index].visible) continue;
        var childPreparation = visit(children[index]);
        if (childPreparation < 0) return -1;
        if (childPreparation) nativePreparation = true;
      }
      if (nativePreparation) {
        var entry = cachedTransformEntries.get(node);
        if (!entry || entry.method !== method || entry.equivalent !== equivalent) {
          entry = { method: method, equivalent: equivalent, nativePreparation: true };
          cachedTransformEntries.set(node, entry);
        }
        entries.set(node, entry);
      }
      return nativePreparation ? 1 : 0;
    }
    if (visit(stage) < 0) return null;
    for (var checkIndex = 0; checkIndex < renderTransformChecks.length; checkIndex++) {
      if (!renderTransformChecks[checkIndex]()) return null;
    }
    return entries;
  }
  function registerTransformEquivalent(method, predecessor, afterChildren, verify, perRender) {
    var equivalent = transformEquivalents.get(predecessor);
    if (!equivalent || typeof method !== 'function' || typeof verify !== 'function') return false;
    // Check global guards once per render and instance guards on each object.
    if (perRender && equivalent.verify) return false;
    if (perRender) renderTransformChecks.push(verify);
    transformEquivalents.set(method, { kind: equivalent.kind, prepare: equivalent.prepare,
      afterChildren: function(node) {
        if (equivalent.afterChildren) equivalent.afterChildren(node);
        if (afterChildren) afterChildren(node);
      }, verifyRender: perRender ? function() {
        return (!equivalent.verifyRender || equivalent.verifyRender()) && verify();
      } : equivalent.verifyRender, verify: perRender ? null : function(node) {
        return (!equivalent.verify || equivalent.verify(node)) && verify(node);
      } });
    return true;
  }

  function registerTransformPreparation(method, prepare, verify) {
    if (typeof method !== 'function' || typeof prepare !== 'function' || typeof verify !== 'function') return false;
    transformEquivalents.set(method, { kind: 'container', prepare: prepare, verify: verify });
    return true;
  }

  var report = { rendererPlugins: [], renderMethodOverrides: [] };
  function scan() {
    var currentPlugins = PIXI.WebGLRenderer &&
      PIXI.WebGLRenderer.__plugins || {};
    report.rendererPlugins = Object.keys(currentPlugins).filter(function(name) {
      return currentPlugins[name] !== baselinePlugins[name];
    }).sort();
    report.renderMethodOverrides = [];
    Object.keys(baselineMethods).forEach(function(name) {
      var proto = knownClasses[name] && knownClasses[name].prototype;
      renderMethods.forEach(function(method) {
        var current = Object.prototype.hasOwnProperty.call(proto, method) ?
          proto[method] : undefined;
        if (current !== baselineMethods[name][method]) {
          report.renderMethodOverrides.push(name + '.' + method);
        }
      });
    });
    report.rendererPlugins.forEach(function(name) {
      PMJS.compat.observed('render.rendererPluginRegistration', name);
    });
    report.renderMethodOverrides.forEach(function(name) {
      PMJS.compat.observed('render.renderMethodOverride', name);
    });
    return report;
  }

  globalThis.pmjsPixiRenderPreflight = { scan: scan, report: report,
    unsupportedMethod: unsupportedMethod, check: check,
    transformPlan: transformPlan, registerTransformEquivalent: registerTransformEquivalent,
    registerTransformPreparation: registerTransformPreparation };
})();
