PMJS.pixi4.scenePreparation = (function() {
var nativeScenePreparationCache = new WeakMap();
function nativeScenePreparationFor(node) {
  if (PIXI.extras && PIXI.extras.BitmapText &&
      node instanceof PIXI.extras.BitmapText) {
    return function(target) {
      if (typeof target.validate === 'function') target.validate();
    };
  }
  if (PIXI.Text && node instanceof PIXI.Text) {
    return function(target, resolution) {
      if (target.resolution !== resolution) {
        target.resolution = resolution;
        target.dirty = true;
      }
      if (typeof target.updateText === 'function') target.updateText(true);
    };
  }
  if (PIXI.mesh && PIXI.mesh.Mesh && node instanceof PIXI.mesh.Mesh) {
    return function(target) {
      if (typeof target.refresh === 'function') target.refresh();
    };
  }
  return null;
}
function nativeScenePreparation(node) {
  var proto = Object.getPrototypeOf(node);
  var preparation = proto && nativeScenePreparationCache.get(proto);
  if (preparation === undefined) {
    preparation = nativeScenePreparationFor(node);
    if (proto) nativeScenePreparationCache.set(proto, preparation);
  }
  return preparation;
}
function prepareNativeSceneNode(node, resolution, transformsPrepared) {
  resolution = typeof resolution === 'number' ? resolution : 1;
  var preparation = nativeScenePreparation(node);
  if (preparation) preparation(node, resolution);
  if (typeof prepareNativeMvSceneNode === 'function') {
    prepareNativeMvSceneNode(node, transformsPrepared);
  }
  if (!transformsPrepared && node.origin && node.tilePosition) {
    node.tilePosition.x = Math.round(-node.origin.x);
    node.tilePosition.y = Math.round(-node.origin.y);
  }
  if (PIXI.extras && node instanceof PIXI.extras.TilingSprite && node.tileTransform &&
      typeof node.tileTransform.updateLocalTransform === 'function') {
    node.tileTransform.updateLocalTransform();
  }
}

function prepareTransforms(plan, stage) {
  var nodeCount = 0;
  function visit(node) {
    nodeCount++;
    var entry = plan.get(node);
    // Callbacks can change the tree. Fall back without repeating earlier updates.
    if (!entry || entry.method !== node.updateTransform || !entry.nativePreparation) {
      node.updateTransform();
      return;
    }
    var equivalent = entry.equivalent;
    if (equivalent.verify && !equivalent.verify(node) ||
        equivalent.verifyRender && !equivalent.verifyRender()) {
      node.updateTransform();
      return;
    }
    if (equivalent.prepare && equivalent.prepare(node) === false) {
      node.updateTransform();
      return;
    }
    if (equivalent.kind === 'Window') {
      node._updateCursor(); node._updateArrows(); node._updatePauseSign(); node._updateContents();
    } else if (equivalent.kind === 'Tilemap' || equivalent.kind === 'ShaderTilemap') {
      prepareNativeMvSceneNode(node, false, equivalent.kind);
    } else if (equivalent.kind === 'MVTilingSprite') {
      node.tilePosition.x = Math.round(-node.origin.x);
      node.tilePosition.y = Math.round(-node.origin.y);
    }
    if (equivalent.kind !== 'leaf') node._boundsID++;
    node.transform.updateTransform(node.parent.transform);
    node.worldAlpha = node.alpha * node.parent.worldAlpha;
    if (equivalent.kind === 'leaf') { node._bounds.updateID++; return; }
    var children = node.children || [];
    for (var index = 0, length = children.length; index < length; index++) {
      var child = node.children[index];
      if (child.visible) visit(child);
    }
    if (equivalent.afterChildren) equivalent.afterChildren(node);
  }
  visit(stage);
  var frameStats = globalThis.pmjsFrameStats;
  if (frameStats) frameStats.addNodes(nodeCount);
}
return { forNode: nativeScenePreparation, prepare: prepareNativeSceneNode,
  transforms: prepareTransforms };
})();
