'use strict';

module.exports = `(function() {
const MPPlugin = {
    TypeParams: { 3: { 'Shape Type': 1, 'Split X': 10, 'Split Y': 6 } },
    LineWidth: 4, FlashOpacity: 200
};
const EncounterEffect = {
    Zoom: 2, NeedClip: true,
    setup(image, kind) {
        this.snap = image;
        this.type = kind;
        this._color = [255, 0, 0];
        const part = new Encounter_Fragment([{ x: 8, y: 10 }, { x: 40, y: 10 }, { x: 8, y: 30 }]);
        part.setSnap(image);
        this._data = [part];
    },
    fragments() { return this._data; },
    clear() { this._data = []; },
    sortFragment(compare) { return this._data.sort(compare); }
};
function Encounter_Fragment(shape) {
    this._frame = shape;
    this.createBitmap();
    this.initFrame();
    this.x = 24;
    this.y = 20;
    this.angle = Math.randomInt(17);
    this.flashColor = null;
    this.visible = false;
    this.jumpHeight = 0;
}
Object.assign(Encounter_Fragment.prototype, {
    rect() { return { x: 8, y: 10, width: 32, height: 20 }; },
    anchorX() { return 0.5; }, anchorY() { return 0.5; },
    scaleX() { return 2; }, scaleY() { return 2; }, rotation() { return 0; },
    createBitmap() {
        trace.bitmaps++;
        const surface = this.bitmap = { _context: {
            save() {}, restore() {}, clip() {},
            stroke() { trace.strokes++; },
            drawImage(_image, x, y) { surface.source = [x, y]; }
        } };
    },
    initFrame() { trace.frames++; },
    setSnap(image) {
        trace.samplers++;
        const drawing = this.bitmap._context;
        const x = this.x + Math.randomInt(17), y = this.y - Math.randomInt(17);
        drawing.save();
        drawing.clip();
        drawing.drawImage(image.canvas, x, y, 32, 20, 4, 5, 16, 10);
        drawing.restore();
    },
    onBreak(color, _image, duration) {
        if (MPPlugin.LineWidth) this.bitmap._context.stroke();
        this.flashColor = color;
        this.visible = true;
        if (EncounterEffect.NeedClip) trace.clips++;
        trace.durations.push(duration);
    }
});
function Sprite_Fragment(part) { this.fragment = part; }
Sprite_Fragment.FlashRate = 8;
globalThis.Scene_Base = function() { Sprite.call(this); };
Scene_Base.prototype = Object.create(Sprite.prototype);
Scene_Base.prototype.createEncEffSprites = function() {
    trace.canvasBuilds++;
    const container = new Sprite();
    container.bitmap = EncounterEffect.snap;
    EncounterEffect.fragments().forEach(part => container.addChild(new Sprite_Fragment(part)));
    this._encEffContainer = container;
    this.addChild(container);
    this.testSprite = container.children[0];
};
globalThis.Scene_Map = function() { Scene_Base.call(this); this.type = 3; };
Scene_Map.prototype = Object.create(Scene_Base.prototype);
Scene_Map.prototype.launchBattle = function() {
    const type = this.type;
    this.beforeSnapshot = true;
    EncounterEffect.setup(SceneManager.snap(), type);
    this.createEncEffSprites();
};
Scene_Map.prototype.updateEncounterEffect = function() {
    for (let tick = 0; tick < 50; tick++) {
        if (tick === 7) trace.music.push(tick);
    }
};
globalThis.fixture = { effect: EncounterEffect, params: MPPlugin.TypeParams[3],
    Scene_Map, Fragment: Encounter_Fragment, flashRate: Sprite_Fragment.FlashRate };
})();\n`;
