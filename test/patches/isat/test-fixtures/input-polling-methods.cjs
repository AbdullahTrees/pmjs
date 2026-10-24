'use strict';
/* global Input, $gameSwitches, $gameVariables */

// Synthetic dispatch with the control-flow contracts exercised by polling tests.
module.exports = {
  executeCommand: function() {
    const entry = this.currentCommand();
    if (!entry) { this.terminate(); return true; }
    this._params = entry.parameters;
    this._indent = entry.indent;
    const operation = this['command' + entry.code];
    if (operation && !operation.call(this)) return false;
    this._index += 1;
    return true;
  },
  currentCommand: function() { return this._list[this._index]; },
  nextEventCode: function() {
    const entry = this._list[this._index + 1];
    return entry ? entry.code : 0;
  },
  skipBranch: function() {
    for (;;) {
      const next = this._list[this._index + 1];
      if (!next || next.indent <= this._indent) break;
      this._index += 1;
    }
  },
  jumpTo: function(destination) {
    this._branch = {};
    this._index = destination;
  },
  command108: function() {
    this._comments = [this._params[0]];
    for (; this.nextEventCode() === 408;) {
      this._index += 1;
      this._comments.push(this.currentCommand().parameters[0]);
    }
    return true;
  },
  command111: function() {
    const p = this._params;
    let answer = false;
    if (p[0] === 11) answer = Input.isPressed(p[1]);
    if (p[0] === 0) answer = $gameSwitches.value(p[1]) === (p[2] === 0);
    if (p[0] === 1) {
      const left = $gameVariables.value(p[1]);
      const right = p[2] === 0 ? p[3] : $gameVariables.value(p[3]);
      answer = [left === right, left >= right, left <= right,
        left > right, left < right, left !== right][p[4]];
    }
    if (p[0] === 12) answer = !!eval(p[1]);
    this._branch[this._indent] = answer;
    if (!answer) this.skipBranch();
    return true;
  },
  command112: function() { return true; },
  command113: function() {
    let nesting = 0;
    for (let cursor = this._index + 1; cursor < this._list.length; cursor++) {
      const code = this._list[cursor].code;
      if (code === 112) nesting++;
      if (code !== 413) continue;
      if (nesting-- > 0) continue;
      this._index = cursor;
      return true;
    }
    this._index = this._list.length;
    return true;
  },
  command115: function() { this._index = this._list.length; return true; },
  command118: function() { return true; },
  command119: function() {
    const destination = this._list.findIndex(entry => entry.code === 118 && entry.parameters[0] === this._params[0]);
    if (destination < 0) return true;
    this.jumpTo(destination);
    return false;
  },
  command411: function() {
    if (this._branch[this._indent] !== false) this.skipBranch();
    return true;
  },
  command413: function() {
    for (let cursor = this._index - 1; cursor >= 0; cursor--) {
      if (this._list[cursor].indent !== this._indent) continue;
      this._index = cursor;
      return true;
    }
    throw new Error('unmatched synthetic loop');
  }
};
