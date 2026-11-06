if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({ id: 'tilemap.stale-prepare-skip',
    owner: 'pmjs-mv',
    fallback: 'run _updateLayerPositions and _sortChildren every frame' });
}
function tilePrepareSkipEnabled() {
  return !!(typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.isEnabled === 'function' &&
    PMJS.optimizations.isEnabled('tilemap.stale-prepare-skip'));
}

function prepareNativeMvWindowTransforms(node) {
  if (!node || !node.visible) return;
  if (typeof Window === 'function' && node instanceof Window) {
    node._updateCursor();
    node._updateArrows();
    node._updatePauseSign();
    node._updateContents();
  }
  var children = node.children || [];
  for (var index = 0; index < children.length; index++) {
    prepareNativeMvWindowTransforms(children[index]);
  }
}

// _updateLayerPositions is a pure function of the camera tile window, the
// sub-tile origin and the layer/priority collections. When those inputs are
// unchanged its writes repeat the previous frame's values.
function layerPositionsStale(node, startX, startY, ox, oy) {
  return node._pmjsLastLayerMethod !== node._updateLayerPositions ||
    node._pmjsLastLayerStartX !== startX || node._pmjsLastLayerStartY !== startY ||
    node._pmjsLastLayerOx !== ox || node._pmjsLastLayerOy !== oy ||
    node._pmjsLastLayerCount !== (node._layers ? node._layers.length : -1) ||
    node._pmjsLastPriorityCount !== (node._priorityTiles ? node._priorityTiles.length : -1);
}

// An already-sorted children array keeps its order under a stable comparator,
// so the O(n) sortedness scan replaces the O(n log n) sort in the common case.
function childrenAlreadySorted(node) {
  var compare = node._compareChildOrder;
  if (typeof compare !== 'function') return false;
  var children = node.children;
  for (var index = 1; index < children.length; index++) {
    if (compare.call(node, children[index - 1], children[index]) > 0) return false;
  }
  return true;
}

function prepareNativeMvSceneNode(node, transformsPrepared, transformKind) {
  if (typeof WindowLayer === 'function' && node instanceof WindowLayer &&
      node.filterArea && typeof node.filterArea.copy === 'function') {
    node.filterArea.copy(node);
  }
  if (!transformsPrepared && typeof Tilemap === 'function' && node instanceof Tilemap) {
    if (!transformKind && typeof node._pmjsPrepareTiles === 'function' && node._pmjsPrepareTiles()) return;
    var rounded = transformKind === 'Tilemap' || node.roundPixels;
    var ox = rounded ? Math.floor(node.origin.x) : node.origin.x;
    var oy = rounded ? Math.floor(node.origin.y) : node.origin.y;
    var startX = Math.floor((ox - node._margin) / node._tileWidth);
    var startY = Math.floor((oy - node._margin) / node._tileHeight);
    var skipStale = tilePrepareSkipEnabled();
    if (!skipStale || layerPositionsStale(node, startX, startY, ox, oy)) {
      node._updateLayerPositions(startX, startY);
      if (skipStale) {
        node._pmjsLastLayerMethod = node._updateLayerPositions;
        node._pmjsLastLayerStartX = startX;
        node._pmjsLastLayerStartY = startY;
        node._pmjsLastLayerOx = ox;
        node._pmjsLastLayerOy = oy;
        node._pmjsLastLayerCount = node._layers ? node._layers.length : -1;
        node._pmjsLastPriorityCount = node._priorityTiles ? node._priorityTiles.length : -1;
      }
    }
    var animationChanged = transformKind !== 'ShaderTilemap' &&
      (transformKind === 'Tilemap' || node._lastAnimationFrame !== undefined) &&
      node._lastAnimationFrame !== node.animationFrame;
    var indexedAnimation = node._pmjsIndexedAnimation === true &&
      typeof node._paintAnimTiles === 'function';
    var fullRepaint = node._needsRepaint ||
      node._lastStartX !== startX || node._lastStartY !== startY;
    if (fullRepaint || (!indexedAnimation && animationChanged)) {
      if (transformKind !== 'ShaderTilemap' &&
          (transformKind === 'Tilemap' || node._lastAnimationFrame !== undefined)) {
        node._frameUpdated = animationChanged;
        node._lastAnimationFrame = node.animationFrame;
      }
      node._lastStartX = startX;
      node._lastStartY = startY;
      node._paintAllTiles(startX, startY);
      node._needsRepaint = false;
      nativeTileRebuilds++;
    } else if (indexedAnimation) {
      if (node._lastAnimationFrame !== undefined) {
        node._frameUpdated = animationChanged;
        node._lastAnimationFrame = node.animationFrame;
      }
      if (node._needsAnimRepaint && node._pmjsChangedAnimKeys) {
        var pending = node._pmjsChangedAnimKeys;
        node._pmjsChangedAnimKeys = null;
        node._needsAnimRepaint = false;
        node._paintAnimTiles(pending);
      }
    }
    if (!skipStale || !childrenAlreadySorted(node)) node._sortChildren();
  }
}
