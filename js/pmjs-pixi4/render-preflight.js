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
  var reviewedTransforms = {
    '9b72717c412d296ece91ea0cc7fab4b4fb6e4616acd1695f341e65c38577bdf6': 'container',
    'f73a944d5eaf648b2bc889563092d8453183be562e30e64d1ba4218d57614677': 'leaf',
    'cb1dd91963c974a21bdaa4d31b75bc8aa5883c0f7f9ef52873fcd028f33771ae': 'Window',
    'd3ad6a2cb5ce923b424a85a4397e81df1cfa310ee441831aafb18443faee4668': 'Tilemap',
    'a7412bdc5b39ba5fc985062655147982aa5f03502f0995cc08f8b622144ccb39': 'ShaderTilemap',
    '5e32e41b3f0bc2145bafdc719d2f913aca029c89c09b4bfeecd93b874b2eddbe': 'MVTilingSprite',
    '6d1393221107188f680e8137675a6665f39d061935185d51d1579d073250c9b5': 'tileLeaf'
  };
  var containerClass = PIXI.Container;
  var displayObjectTransform = PIXI.DisplayObject && PIXI.DisplayObject.prototype.updateTransform;
  var containerTransform = PIXI.Container && PIXI.Container.prototype.updateTransform;
  var tilingTransform = globalThis.TilingSprite && TilingSprite.prototype.updateTransformTS;
  function reviewedTransform(method) {
    if (typeof method !== 'function' || !globalThis.__pmjsBuiltinRequire) return null;
    var source = Function.prototype.toString.call(method)
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(').replace(/\s/g, '');
    return reviewedTransforms[__pmjsBuiltinRequire('crypto').createHash('sha256').update(source).digest('hex')];
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
