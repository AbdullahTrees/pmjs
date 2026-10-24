'use strict';

PMJS.phases.on('beforePlugins', 'pmjs-lookoutside.dom', function() {
  // index.html supplies this canvas for the game's periodic overlay workaround.
  var refresher = document.createElement('canvas');
  refresher.id = 'refresher';
  document.body.appendChild(refresher);
});
