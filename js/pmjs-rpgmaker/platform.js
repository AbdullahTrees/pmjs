if (typeof SceneManager !== 'undefined') {
  if (PMJS.config.developmentMode) {
    SceneManager.catchException = function(error) { throw error; };
  }
}
