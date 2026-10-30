// Retained scene encoding: when a node's record inputs are unchanged, copy its
// record range out of the previous frame's buffers instead of re-encoding it.
// The signature is the record's own words (metadata 0 and 2..6, values 0..40)
// stored as exact bit patterns, so an equal signature means byte-identical
// records by construction — no change counters, no hashing, no plugin names.
// Spliced records skip per-frame compat counters; bindTexture hints are
// replayed from the entry so texture liveness stays warm.

if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({ id: 'render.retained-encoding',
    owner: 'pmjs-pixi4',
    fallback: 'encode every record from scratch each frame' });
}

PMJS.pixi4 = PMJS.pixi4 || {};
PMJS.pixi4.retained = (function() {
  var SIG_STRIDE = 47;
  var PROBE_INTERVAL = 15;
  var MIN_SPLICE_NUMERATOR = 1, MIN_SPLICE_DENOMINATOR = 4;

  var castF = new Float32Array(1);
  var castU = new Uint32Array(castF.buffer);
  function f32bits(value) {
    castF[0] = value;
    return castU[0];
  }

  var entries = new WeakMap();
  var prev = null;
  var sigWrite = null;
  var sigPrev = null;
  var sigCursor = 0;
  var frame = 0;
  var lastStage = null, lastPreconditions = null;
  var verifyFailed = false, verifySetting = null;
  var skipIn = 0, harvestNext = false;
  var lastSpliced = 0, lastRecords = 0;
  var current = { active: false, phaseA: false, spliced: 0, encoded: 0 };
  var stats = { frames: 0, phaseA: 0, probes: 0, resets: 0, mismatched: 0,
    splicedRecords: 0, encodedRecords: 0 };

  function envFlag(name) {
    return typeof NativeHost !== 'undefined' && NativeHost.runtime &&
      NativeHost.runtime.env && NativeHost.runtime.env(name) === '1';
  }

  function verifyEnabled() {
    if (verifySetting === null) verifySetting = envFlag('PMJS_RETAINED_VERIFY');
    return verifySetting;
  }

  function reset() {
    entries = new WeakMap();
    prev = null;
    sigPrev = null;
    sigCursor = 0;
    stats.resets++;
  }

  function arenaEnsure(words) {
    if (!sigWrite) sigWrite = new Uint32Array(SIG_STRIDE * 256);
    if (sigCursor + words <= sigWrite.length) return;
    var size = sigWrite.length * 2;
    while (sigCursor + words > size) size *= 2;
    var grown = new Uint32Array(size);
    grown.set(sigWrite.subarray(0, sigCursor));
    sigWrite = grown;
  }

  function sigEqual(oldOffset, newOffset) {
    for (var word = 0; word < SIG_STRIDE; word++) {
      if (sigPrev[oldOffset + word] !== sigWrite[newOffset + word]) return false;
    }
    return true;
  }

  function eligible(node) {
    if (!node) return false;
    if (nativeIsRectTileLayer(node)) return false;
    if (nativeSceneNodeRejected(node, null)) return false;
    if (node._cacheAsBitmap || node.shader || node.mask || node._mask ||
        node._filters) return false;
    if (typeof WindowLayer === 'function' && node instanceof WindowLayer) return false;
    if (typeof Tilemap === 'function' && node instanceof Tilemap) return false;
    if (PIXI.particles && PIXI.particles.ParticleContainer &&
        node instanceof PIXI.particles.ParticleContainer) return false;
    // prepare() rounds these in local frames; splicing would skip the mutation.
    if (node.origin && node.tilePosition) return false;
    if (PMJS.pixi4.bitmapPresentation && PMJS.pixi4.bitmapPresentation.has(node)) {
      return false;
    }
    if (PMJS.pixi4.scenePreparation && PMJS.pixi4.scenePreparation.forNode(node)) {
      return false;
    }
    var producer = pmjsPixiRenderPreflight.producer(node);
    if (producer.prepareBeforeFilters || producer.filterAccess === 'public') {
      return false;
    }
    // Everything check()/checkLeaf() would throw on must run its body.
    if (pmjsPixiRenderPreflight.unsupportedMethod(node, producer)) return false;
    var type = nativeNodeRenderType(node);
    if (type === 'sprite' || type === 'picture') {
      return nativeSceneBlendMode(node) >= 0 && nativeScenePictureBlend(node) < 0 &&
        !(node.children && node.children.length);
    }
    return type === 'container' && nativeSceneBlendMode(node) >= 0;
  }

  // Signature words, in record overwrite order so transcriptions line up with
  // the writer. Word 2 may become the packed world-state colour; words 6..11
  // may become the prepared world transform and then the sprite quad.
  function captureSigWords(node, isRoot, offset, kind, image, texture, frame0) {
    var u = sigWrite;
    var transform = node.transform;
    if (!nativeSceneTransformsPrepared && transform && !(isRoot &&
        nativeSceneRootUsesWorldTransform) &&
        typeof transform.updateLocalTransform === 'function') {
      transform.updateLocalTransform();
    }
    var local = transform && (isRoot && nativeSceneRootUsesWorldTransform ?
      transform.worldTransform : transform.localTransform) ||
      nativeIdentityTransform;
    if (isRoot && nativeSceneRootTransform !== nativeIdentityTransform) {
      local = nativeComposeTransform(nativeSceneRootTransform, local);
    }
    var tint = node.tint === undefined ? 0xffffff : node.tint;
    var blendMode = nativeSceneBlendMode(node);
    var alpha = isRoot && nativeSceneRootUsesWorldTransform ?
      node.worldAlpha : node.alpha;

    u[offset] = kind;
    u[offset + 1] = kind === 1 ? image.handle : 0;
    u[offset + 2] = tint >>> 0;
    u[offset + 3] = blendMode >>> 0;
    u[offset + 4] = 0;
    u[offset + 5] = 0;
    u[offset + 6] = f32bits(local.a);
    u[offset + 7] = f32bits(local.b);
    u[offset + 8] = f32bits(local.c);
    u[offset + 9] = f32bits(local.d);
    u[offset + 10] = f32bits(local.tx);
    u[offset + 11] = f32bits(local.ty);
    u[offset + 12] = f32bits(alpha);
    for (var zero = 13; zero < SIG_STRIDE; zero++) u[offset + zero] = 0;

    var flags = 0;
    if (nativeSceneUsePixiWorldState && node.worldTransform) {
      var world = node.worldTransform;
      if (nativeSceneRootTransform !== nativeIdentityTransform) {
        world = nativeComposeTransform(nativeSceneRootTransform, world);
      }
      var finite = true;
      var components = ['a', 'b', 'c', 'd', 'tx', 'ty'];
      for (var component = 0; component < 6; component++) {
        u[offset + 6 + component] = f32bits(world[components[component]]);
        if (!Number.isFinite(castF[0])) finite = false;
      }
      if (!finite) {
        for (var coordinate = 0; coordinate < 6; coordinate++) {
          u[offset + 6 + coordinate] = 0;
        }
      }
      var worldAlpha = node.worldAlpha;
      u[offset + 12] = f32bits(Number.isFinite(Math.fround(worldAlpha)) ?
        worldAlpha : 1);
      flags |= 524288;
    }

    if (kind === 1) {
      var base = texture.baseTexture;
      var anchor = node.anchor || { x: 0, y: 0 };
      var original = texture.orig || frame0;
      var trim = texture.trim;
      u[offset + 13] = f32bits(trim ? trim.x - anchor.x * original.width :
        -anchor.x * original.width);
      u[offset + 14] = f32bits(trim ? trim.y - anchor.y * original.height :
        -anchor.y * original.height);
      var resolution = Math.max(0.000001, Number(base && base.resolution) || 1);
      // The writer stages the origin through the float32 slot before scaling.
      castF[0] = frame0.x;
      u[offset + 15] = f32bits(castF[0] * resolution);
      castF[0] = frame0.y;
      u[offset + 16] = f32bits(castF[0] * resolution);
      u[offset + 17] = f32bits(frame0.width * resolution);
      u[offset + 18] = f32bits(frame0.height * resolution);
      u[offset + 19] = f32bits(trim ? trim.width : original.width);
      u[offset + 20] = f32bits(trim ? trim.height : original.height);
      var rotation = ((Number(texture.rotate) || 0) % 16 + 16) % 16;
      flags |= rotation / 2 << 5;
      if (PIXI.SCALE_MODES && base.scaleMode === PIXI.SCALE_MODES.NEAREST) flags |= 8;
      if (base.mipmap && !(PIXI.BaseRenderTexture &&
          base instanceof PIXI.BaseRenderTexture)) flags |= 65536;
      if (base.__pmjsPremultiplied) flags |= 1024;
      if (texture.__pmjsStandaloneBitmapRegion) flags |= 8192;
      if (nativeSceneRoundPixels) flags |= 256;
      var cpuTinted = node._tintTexture && texture && base === node._tintTexture;
      var colorTone = cpuTinted ? null : node._colorTone;
      var blendColor = cpuTinted ? null : node._blendColor;
      if ((colorTone && (colorTone[0] || colorTone[1] || colorTone[2] ||
           colorTone[3])) || (blendColor && blendColor[3] > 0)) {
        flags |= 16;
        for (var colorIndex = 0; colorIndex < 4; colorIndex++) {
          u[offset + 39 + colorIndex] = f32bits(colorTone ?
            Math.max(-255, Math.min(255, Number(colorTone[colorIndex]) || 0)) / 255 : 0);
          u[offset + 43 + colorIndex] = f32bits(blendColor ?
            Math.max(0, Math.min(255, Number(blendColor[colorIndex]) || 0)) / 255 : 0);
        }
        castU[0] = u[offset + 42];
        u[offset + 42] = f32bits(Math.max(0, castF[0]));
      }
      if (!(isRoot && nativeSceneRootUsesWorldTransform) &&
          nativeSceneUsePixiWorldState) {
        var packedAlpha = Math.min(1, node.worldAlpha);
        var red = packedAlpha < 1 ?
          Math.floor(((tint >>> 16) & 255) * packedAlpha + 0.5) : ((tint >>> 16) & 255);
        var green = packedAlpha < 1 ?
          Math.floor(((tint >>> 8) & 255) * packedAlpha + 0.5) : ((tint >>> 8) & 255);
        var blue = packedAlpha < 1 ?
          Math.floor((tint & 255) * packedAlpha + 0.5) : (tint & 255);
        u[offset + 2] = (((packedAlpha * 255) << 24) | (red << 16) |
          (green << 8) | blue) >>> 0;
        flags |= 2048;
      }
      if (nativeSceneUsePixiWorldState && !(node.children && node.children.length) &&
          typeof node.calculateVertices === 'function') {
        node.calculateVertices();
        var vertices = node.vertexData;
        if (vertices && vertices.length === 8) {
          var drawable = true;
          for (var corner = 0; corner < 4; corner++) {
            var x = vertices[corner * 2], y = vertices[corner * 2 + 1];
            if (nativeSceneRootTransform !== nativeIdentityTransform) {
              var root = nativeSceneRootTransform;
              // Both projected axes must read the untransformed corner like the
              // writer does; reusing the stored x here drops x out of the
              // fingerprint whenever the root transform is rotated.
              var projectedX = root.a * x + root.c * y + root.tx;
              var projectedY = root.b * x + root.d * y + root.ty;
              x = projectedX;
              y = projectedY;
            }
            var destination = offset + (corner < 3 ? 6 + corner * 2 : 21);
            u[destination] = f32bits(x);
            u[destination + 1] = f32bits(y);
            castU[0] = u[destination];
            var drawn = Number.isFinite(castF[0]);
            castU[0] = u[destination + 1];
            drawn = drawn && Number.isFinite(castF[0]);
            drawable = drawable && drawn;
          }
          if (!drawable) {
            for (var zeroed = 0; zeroed < 4; zeroed++) {
              var slot = offset + (zeroed < 3 ? 6 + zeroed * 2 : 21);
              u[slot] = 0;
              u[slot + 1] = 0;
            }
          }
          flags |= 4096;
        }
      }
    }
    u[offset + 4] = flags >>> 0;
  }

  function visit(node, isRoot) {
    if (!eligible(node)) return null;
    var type = nativeNodeRenderType(node);
    var childEntries = [];
    if (type === 'container') {
      var children = node.children || [];
      for (var index = 0; index < children.length; index++) {
        if (nativeSceneNodeRejected(children[index], null)) continue;
        var childEntry = visit(children[index], false);
        if (!childEntry) {
          // A node without an entry re-encodes every frame and can never
          // splice, so its parent stays dirty — but that must not hide the
          // clean siblings behind it from the walk. The marker also keeps the
          // child list a faithful identity list, so the volatile node's
          // removal or replacement invalidates the parent's spliced range.
          childEntry = { node: children[index], start: -1, count: 0,
            sigOffset: -1, childEntries: [], sigStamp: -1, stamp: -1,
            clean: false, texture: null };
        }
        childEntries.push(childEntry);
      }
    }
    var kind = (type === 'sprite' || type === 'picture') ? 1 : 0;
    var texture = null, frame0 = null, base = null, image = null;
    if (kind === 1) {
      texture = node.texture;
      base = texture && texture.baseTexture;
      frame0 = texture && (texture._frame || texture.frame);
      image = nativeTextureSource(base && base.source);
      if (!(image && frame0 && frame0.width > 0 && frame0.height > 0)) {
        kind = 0;
      } else {
        // Runs of plain siblings encode through the segment path, which stages
        // frame.x/y in one store; retain only when both orders land on the
        // same float32 so the record cannot depend on which path emitted it.
        var resolution = Math.max(0.000001, Number(base.resolution) || 1);
        castF[0] = frame0.x;
        var stagedX = f32bits(castF[0] * resolution);
        castF[0] = frame0.y;
        var stagedY = f32bits(castF[0] * resolution);
        if (stagedX !== f32bits(frame0.x * resolution) ||
            stagedY !== f32bits(frame0.y * resolution)) return null;
      }
    }
    arenaEnsure(SIG_STRIDE);
    var offset = sigCursor;
    sigCursor += SIG_STRIDE;
    captureSigWords(node, isRoot, offset, kind, image, texture, frame0);
    var entry = entries.get(node);
    if (!entry) {
      entry = { node: node, start: -1, count: 0, sigOffset: -1,
        childEntries: null, sigStamp: -1, stamp: -1, clean: false };
      entries.set(node, entry);
    }
    var clean = entry.stamp === frame - 1 && entry.sigOffset >= 0 &&
      entry.count > 0 && sigEqual(entry.sigOffset, offset);
    if (clean && entry.childEntries.length !== childEntries.length) clean = false;
    if (clean) {
      // The spliced range covers this node's whole subtree, so every
      // descendant record must be reproducible too, not just this node's.
      for (var child = 0; child < childEntries.length; child++) {
        if (entry.childEntries[child].node !== childEntries[child].node ||
            !childEntries[child].clean) {
          clean = false;
          break;
        }
      }
    }
    entry.sigOffset = offset;
    entry.sigStamp = frame;
    entry.childEntries = childEntries;
    entry.clean = clean;
    entry.texture = kind === 1 ? base : null;
    return entry;
  }

  function shiftEntry(entry, delta) {
    entry.start += delta;
    entry.stamp = frame;
    if (nativeSceneRenderer && entry.texture) {
      nativeSceneRenderer.bindTexture(entry.texture);
    }
    for (var index = 0; index < entry.childEntries.length; index++) {
      shiftEntry(entry.childEntries[index], delta);
    }
  }

  function beginFrame(stage, backgroundColor) {
    current.active = false;
    current.phaseA = false;
    if (verifyFailed) return;
    if (PMJS.optimizations && typeof PMJS.optimizations.isEnabled === 'function' &&
        !PMJS.optimizations.isEnabled('render.retained-encoding')) return;
    frame++;
    stats.frames++;
    var preconditions = [stage === null ? 0 : 1,
      backgroundColor === null ? 0 : backgroundColor,
      nativeSceneUsePixiWorldState ? 1 : 0,
      nativeSceneRootUsesWorldTransform ? 1 : 0,
      nativeSceneRootTransform.a, nativeSceneRootTransform.b,
      nativeSceneRootTransform.c, nativeSceneRootTransform.d,
      nativeSceneRootTransform.tx, nativeSceneRootTransform.ty,
      nativeSceneFilterResolution, nativeSceneRoundPixels ? 1 : 0,
      nativeSceneTransformsPrepared ? 1 : 0,
      nativeScenePlainSpriteSegments &&
        PMJS.optimizations.isEnabled('scene.plain-sprite-segment') ? 1 : 0];
    if (stage !== lastStage || !lastPreconditions ||
        preconditions.some(function(value, index) {
          return value !== lastPreconditions[index];
        })) {
      reset();
      lastStage = stage;
      lastPreconditions = preconditions;
    }
    var phaseA;
    if (verifyEnabled()) phaseA = true;
    else if (harvestNext) { harvestNext = false; phaseA = true; }
    else if (lastRecords === 0 || lastSpliced * MIN_SPLICE_DENOMINATOR >=
        lastRecords * MIN_SPLICE_NUMERATOR) {
      skipIn = 0;
      phaseA = true;
    } else if (skipIn > 0) { skipIn--; phaseA = false; }
    else {
      harvestNext = true;
      skipIn = PROBE_INTERVAL;
      phaseA = true;
      stats.probes++;
    }
    current.phaseA = phaseA;
    if (phaseA) {
      stats.phaseA++;
      var swapSig = sigPrev;
      sigPrev = sigWrite;
      sigWrite = swapSig;
      sigCursor = 0;
      visit(stage, true);
    }
    // submitScene copies the packet out before returning, so the parked
    // buffer from two frames ago is free to overwrite; a queued render
    // thread (roadmap item 5) would need its own pair instead.
    var swap = prev;
    prev = { metadata: nativeSceneMetadata, values: nativeSceneValues,
      count: nativeSceneCount, capacity: nativeSceneCapacity };
    if (swap) {
      nativeSceneMetadata = swap.metadata;
      nativeSceneValues = swap.values;
      nativeSceneCapacity = swap.capacity;
    } else {
      nativeSceneMetadata = new Uint32Array(512 * nativeSceneMetadataStride);
      nativeSceneValues = new Float32Array(512 * nativeSceneValueStride);
      nativeSceneCapacity = 512;
    }
    nativeSceneCount = 0;
    current.active = true;
  }

  function endFrame() {
    if (!current.active) return;
    lastSpliced = current.spliced;
    lastRecords = nativeSceneCount;
    stats.splicedRecords += current.spliced;
    stats.encodedRecords += current.encoded;
    current.spliced = 0;
    current.encoded = 0;
    // The latch covers exactly one encode; between frames other encodes
    // must see retention as idle.
    current.active = false;
  }

  function splice(node, parentIndex, forcedClip, forcedMask, particleContext,
      forcedAlpha) {
    if (nativeSceneEncodingDepth !== 1) return false;
    if (forcedClip || forcedMask || particleContext || forcedAlpha !== undefined) {
      return false;
    }
    var entry = entries.get(node);
    if (!entry || !entry.clean || entry.count <= 0 || entry.start < 0 ||
        entry.sigStamp !== frame || entry.stamp !== frame - 1 ||
        entry.start + entry.count > prev.count) return false;
    var count = entry.count;
    var newStart = nativeSceneCount;
    while (newStart + count > nativeSceneCapacity) growNativeScene();
    nativeSceneMetadata.set(prev.metadata.subarray(entry.start * 7,
      (entry.start + count) * 7), newStart * 7);
    nativeSceneValues.set(prev.values.subarray(entry.start * 41,
      (entry.start + count) * 41), newStart * 41);
    var delta = newStart - entry.start;
    for (var record = 0; record < count; record++) {
      var word = (newStart + record) * 7 + 1;
      if (record === 0) nativeSceneMetadata[word] = parentIndex;
      else nativeSceneMetadata[word] = (nativeSceneMetadata[word] + delta) >>> 0;
    }
    nativeSceneCount = newStart + count;
    shiftEntry(entry, delta);
    current.spliced += count;
    return true;
  }

  function stampEntry(entry, startIndex, count, forced) {
    if (entry.stamp === frame) {
      // Encoded twice in one frame (shared subtree), or shifted by an ancestor
      // splice; the range would be ambiguous, so revalidation must recapture.
      entry.stamp = -2;
      return;
    }
    entry.start = startIndex;
    entry.count = count;
    // A forced record embeds effect-scope words the signature does not model.
    entry.stamp = !forced && entry.sigStamp === frame ? frame : -1;
    current.encoded += count;
  }

  function capture(node, startIndex, forced) {
    if (!current.active || nativeSceneEncodingDepth !== 1) return;
    var entry = entries.get(node);
    if (!entry) return;
    stampEntry(entry, startIndex, nativeSceneCount - startIndex, forced);
  }

  function captureSegment(bindings, firstIndex) {
    if (!current.active || nativeSceneEncodingDepth !== 1) return;
    for (var index = 0; index < bindings.length; index++) {
      var entry = entries.get(bindings[index].node);
      if (entry) stampEntry(entry, firstIndex + index, 1, false);
    }
  }

  function verifyActive() {
    return !verifyFailed && verifyEnabled();
  }

  // Immediate encode into private buffers: the reference the retained packet is
  // compared against. Runs at encoding depth 2 so the splice hook stays inert.
  function verifyEncode(stage, backgroundColor) {
    var previous = { metadata: nativeSceneMetadata, values: nativeSceneValues,
      capacity: nativeSceneCapacity, count: nativeSceneCount,
      bulkClear: nativeSceneBulkClear, filterDepth: nativeSceneFilterDepth,
      emission: nativeSceneEmission, plans: nativeCustomFilterPlans,
      overlays: nativeScreenOverlays.length, tileRects: nativeTileRects };
    nativeSceneMetadata = new Uint32Array(nativeSceneCapacity * nativeSceneMetadataStride);
    nativeSceneValues = new Float32Array(nativeSceneCapacity * nativeSceneValueStride);
    nativeSceneCount = 0;
    nativeSceneEmission = null;
    // The scratch runs after the live encode has unwound, so one increment
    // would land on 1 where splice/capture are live and the second stamping
    // poisons every entry; two keeps the hooks inert as intended.
    nativeSceneEncodingDepth += 2;
    nativeCustomFilterPlans = [];
    resetNativeSceneRecords();
    nativeSceneBulkClear = false;
    nativeSceneFilterDepth = 0;
    try {
      if (backgroundColor !== null) {
        nativeSceneRecord(0xffffffff, 3, 0, backgroundColor, 0,
          nativeIdentityTransform, 1, null, 0, null);
      }
      writeNativeSceneNode(stage, 0xffffffff);
      return { version: nativeScenePacketVersion, metadata: nativeSceneMetadata,
        values: nativeSceneValues, count: nativeSceneCount,
        customFilterPlans: nativeCustomFilterPlans };
    } finally {
      // The scratch encode must leave the frame's observable side outputs alone.
      nativeScreenOverlays.length = previous.overlays;
      nativeTileRects = previous.tileRects;
      nativeSceneEncodingDepth -= 2;
      nativeSceneMetadata = previous.metadata;
      nativeSceneValues = previous.values;
      nativeSceneCapacity = previous.capacity;
      nativeSceneCount = previous.count;
      nativeSceneBulkClear = previous.bulkClear;
      nativeSceneFilterDepth = previous.filterDepth;
      nativeSceneEmission = previous.emission;
      nativeCustomFilterPlans = previous.plans;
    }
  }

  function verifyCompare(packet, scratch) {
    if (packet.count !== scratch.count) {
      return 'record count ' + packet.count + ' != ' + scratch.count;
    }
    for (var record = 0; record < packet.count; record++) {
      for (var word = 0; word < 7; word++) {
        if (word === 1) continue;
        var offset = record * 7 + word;
        if (packet.metadata[offset] !== scratch.metadata[offset]) {
          return 'record ' + record + ' metadata[' + word + '] retained=' +
            packet.metadata[offset] + ' immediate=' + scratch.metadata[offset];
        }
      }
      for (var value = 0; value < 41; value++) {
        var valueOffset = record * 41 + value;
        if (packet.values[valueOffset] !== scratch.values[valueOffset]) {
          return 'record ' + record + ' values[' + value + '] retained=' +
            packet.values[valueOffset] + ' immediate=' + scratch.values[valueOffset];
        }
      }
    }
    if (packet.customFilterPlans.length !== scratch.customFilterPlans.length) {
      return 'filter plan count ' + packet.customFilterPlans.length + ' != ' +
        scratch.customFilterPlans.length;
    }
    for (var plan = 0; plan < packet.customFilterPlans.length; plan++) {
      var left, right;
      try {
        left = JSON.stringify(packet.customFilterPlans[plan]);
        right = JSON.stringify(scratch.customFilterPlans[plan]);
      } catch (error) {
        continue;
      }
      if (left !== right) return 'filter plan ' + plan + ' differs';
    }
    return null;
  }

  function verifyFail(detail) {
    verifyFailed = true;
    stats.mismatched++;
    console.error('[pmjs-retained] verify mismatch: ' + detail +
      '; falling back to immediate encoding');
  }

  return { get active() { return current.active; },
    beginFrame: beginFrame, endFrame: endFrame,
    splice: splice, capture: capture, captureSegment: captureSegment,
    verifyActive: verifyActive, verifyEncode: verifyEncode,
    verifyCompare: verifyCompare, verifyFail: verifyFail,
    verifyDispose: function(packet) {
      if (packet && packet.customFilterPlans) {
        disposeNativeCustomFilterPlans(packet.customFilterPlans);
      }
    },
    stats: stats };
})();
