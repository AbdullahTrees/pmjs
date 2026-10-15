'use strict';

PMJS.plugins.onLoaded('YEP_CommonEventMenu', 'pmjs.adapter.common-event-menu', function() {
  var proto = Window_CommonEventMenuPicture.prototype;
  var refresh = proto.refresh;
  proto.refresh = function() {
    this._pmjsPictureRequest = {};
    return refresh.apply(this, arguments);
  };
  var draw = proto.drawPicture;
  proto.drawPicture = function() {
    var bitmap = this._pictureBitmap;
    if (!this._picture || !bitmap) return;
    if (bitmap.width > 0) return draw.apply(this, arguments);
    var request = this._pmjsPictureRequest;
    if (this._pmjsPendingPicture === request) return;
    this._pmjsPendingPicture = request;
    var window = this, destination = this.contents, picture = this._picture;
    bitmap.addLoadListener(function() {
      if (window._pmjsPictureRequest !== request || window._picture !== picture ||
          window._pictureBitmap !== bitmap || window.contents !== destination ||
          bitmap.width <= 0) return;
      window._pmjsPendingPicture = null;
      window.drawPicture();
    });
  };
  var terminate = Scene_Base.prototype.terminate;
  Scene_Base.prototype.terminate = function() {
    var window = this._commonEventMenuPictureWindow;
    if (window) window._pmjsPictureRequest = null;
    return terminate.apply(this, arguments);
  };
});
