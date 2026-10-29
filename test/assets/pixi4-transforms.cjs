'use strict';

// PixiJS 4.5.4; MIT, see ../../third_party/pixi4.LICENSE.
module.exports = {
  "container": "function updateTransform() {\n        this._boundsID++;\n\n        this.transform.updateTransform(this.parent.transform);\n\n        // TODO: check render flags, how to process stuff here\n        this.worldAlpha = this.alpha * this.parent.worldAlpha;\n\n        for (var i = 0, j = this.children.length; i < j; ++i) {\n            var child = this.children[i];\n\n            if (child.visible) {\n                child.updateTransform();\n            }\n        }\n    }",
  "leaf": "function updateTransform() {\n        this.transform.updateTransform(this.parent.transform);\n        // multiply the alphas..\n        this.worldAlpha = this.alpha * this.parent.worldAlpha;\n\n        this._bounds.updateID++;\n    }"
};
