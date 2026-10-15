'use strict';

const path = require('node:path');
const locks = new Map();

function preparationLocks() {
  return {
    tryAcquirePreparationLock(root) {
      const key = path.resolve(root);
      if (locks.has(key)) return null;
      const token = { key };
      locks.set(key, token);
      return token;
    },
    releasePreparationLock(token) {
      if (locks.get(token.key) === token) locks.delete(token.key);
    }
  };
}

module.exports = { preparationLocks };
