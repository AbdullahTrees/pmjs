'use strict';

(function() {
  var budgetMs = PMJS.config.interpreterBudgetMs;
  if (budgetMs === undefined || budgetMs === 0) return;
  if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new TypeError('interpreterBudgetMs must be a non-negative finite number');
  }

  var depth = 0;
  var startedAt = 0;
  var checks = 0;
  var exhausted = false;

  PMJS.methods.wrap({
    key: 'Game_Interpreter.update',
    id: 'pmjs.mv.interpreter-budget-update',
    getTarget: function() { return Game_Interpreter.prototype; },
    method: 'update',
    wrap: function(guestUpdate) {
      return function() {
        // A child shares its outer execution's deadline; rendering does not reset it.
        if (depth === 0) {
          startedAt = performance.now();
          checks = 0;
          exhausted = false;
        }
        depth++;
        try {
          return guestUpdate.apply(this, arguments);
        } finally {
          depth--;
        }
      };
    }
  });

  PMJS.methods.wrap({
    key: 'Game_Interpreter.checkFreeze',
    id: 'pmjs.mv.interpreter-budget-check',
    getTarget: function() { return Game_Interpreter.prototype; },
    method: 'checkFreeze',
    wrap: function(guestCheckFreeze) {
      return function() {
        var result = guestCheckFreeze.apply(this, arguments);
        if (result || depth === 0) return result;
        if (exhausted) return true;
        if ((++checks & 63) === 0) {
          exhausted = performance.now() - startedAt >= budgetMs;
        }
        return exhausted || result;
      };
    }
  });
})();
