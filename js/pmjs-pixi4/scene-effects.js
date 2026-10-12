var nativeSpriteMaskConstructor = PIXI.SpriteMaskFilter;
var nativeSpriteMaskFilters = new WeakMap();

function nativeNodeNeedsAdvancedEffects(enabledFilterCount, nodeMask,
    forcedMask, pictureBlend) {
  return enabledFilterCount !== 0 || !!nodeMask || !!forcedMask ||
    pictureBlend >= 0;
}

function nativeFilterGroupPreservesTransparentBounds(group) {
  return !!group && group.preservesTransparentBlack === true;
}

function nativeSceneAncestorHasMask(parentIndex) {
  while (parentIndex !== undefined && parentIndex !== 0xffffffff) {
    var offset = parentIndex * nativeSceneMetadataStride;
    if (nativeSceneMetadata[offset + 5] & 5) return true;
    parentIndex = nativeSceneMetadata[offset + 1];
  }
  return false;
}

function resolveNativeAdvancedEffects(node, particleContext, activeFilters,
    nodeMask, forcedMask, pictureBlend, forcedClip, parentIndex) {
  var filterPlan = nativeSceneFilter(node, activeFilters);
  if (filterPlan.unsupported) {
    var filterNames = filterPlan.filters.map(function(filter) {
      return filter && filter.constructor && filter.constructor.name || 'filter';
    }).join(',');
    PMJS.compat.hit('render.filter',
      (node.constructor && node.constructor.name || 'node') + ':' + filterNames);
    filterPlan = { blur: 0, groups: [] };
  }

  var scissorClip = null;
  if (!particleContext && nodeMask && nativeSceneUsePixiWorldState &&
      typeof nodeMask.getBounds === 'function') {
    var renderer = globalThis.Graphics && Graphics._renderer;
    var target = renderer && renderer._activeRenderTarget;
    var matrix = nodeMask.worldTransform;
    var rotation = matrix && Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
    // Only root scissor masks refresh bounds; sprite and stencil masks use cached state.
    if (nodeMask.texture) node.filterArea = nodeMask.getBounds(true);
    else if (!nativeSceneFilterDepth && !filterPlan.groups.length &&
        !nativeSceneAncestorHasMask(parentIndex) &&
        (!target || target.root !== false) && typeof nodeMask.isFastRect === 'function' &&
        nodeMask.isFastRect() && rotation % 90 === 0) {
      nodeMask.renderable = true;
      var bounds;
      try { bounds = nodeMask.getBounds(); }
      finally { nodeMask.renderable = false; }
      var size = target && target.size || { x: 0, y: 0,
        width: globalThis.Graphics && Graphics.width || 816,
        height: globalThis.Graphics && Graphics.height || 624 };
      bounds.fit(size);
      var resolution = renderer && renderer.resolution || 1;
      var left = Math.trunc(bounds.x * resolution);
      var height = Math.trunc(bounds.height * resolution);
      var bottom = size.height * resolution -
        Math.trunc((size.height - bounds.y - bounds.height) * resolution);
      scissorClip = { left: left, top: bottom - height,
        right: left + Math.trunc(bounds.width * resolution), bottom: bottom };
    }
  }

  var canKeepRectangleMask = !filterPlan.groups.length ||
    filterPlan.groups.every(nativeFilterGroupPreservesTransparentBounds);
  var maskClip = scissorClip || (!particleContext && nodeMask && canKeepRectangleMask ?
    nativeRectangleMask(nodeMask) : null);
  var nativeClip = nativeIntersectClip(forcedClip, maskClip);
  var spriteMaskGroup = null;
  if (!particleContext && nodeMask && nodeMask.texture && !maskClip &&
      nativeSceneUsePixiWorldState && typeof nativeSpriteMaskConstructor === 'function') {
    var spriteMaskFilter = nativeSpriteMaskFilters.get(nodeMask);
    if (!spriteMaskFilter) {
      spriteMaskFilter = new nativeSpriteMaskConstructor(nodeMask);
      nativeSpriteMaskFilters.set(nodeMask, spriteMaskFilter);
    }
    spriteMaskGroup = nativeCustomFilterGroup(spriteMaskFilter, node);
    if (!spriteMaskGroup) {
      PMJS.compat.hit('render.mask', 'sprite mask filter could not be encoded');
      return null;
    }
  }
  var nativeMask = !spriteMaskGroup && !particleContext && nodeMask && !maskClip ?
    nativeAlphaMask(nodeMask) : null;
  if (!particleContext && nodeMask && !nativeClip && !nativeMask && !spriteMaskGroup) {

    PMJS.compat.hit('render.mask',
      node.constructor && node.constructor.name || 'node');
    return null;
  }
  if (spriteMaskGroup) filterPlan.groups.unshift(spriteMaskGroup);
  var nativeMasks = [];
  if (nativeMask) nativeMasks.push(nativeMask);
  if (forcedMask) nativeMasks.push(forcedMask);
  for (var nativeMaskIndex = 0; nativeMaskIndex < nativeMasks.length;
      nativeMaskIndex++) {
    var currentMask = nativeMasks[nativeMaskIndex];

    filterPlan.groups.unshift({ kind: 3, resource: currentMask.handle,
      parameters: currentMask.transform.concat(currentMask.frame,
        [currentMask.alpha, currentMask.usesRed ? 1 : 0,
          currentMask.rotation, currentMask.size[0], currentMask.size[1]]) });
  }

  if (pictureBlend >= 0) {
    filterPlan.groups.push({ kind: 26, resource: 0,
      parameters: [pictureBlend] });
  }
  filterPlan.clip = nativeClip;

  return filterPlan;
}
