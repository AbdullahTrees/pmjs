'use strict';

const { format } = require('node:util');
const HostDate = Date;

function installConsoleLogging(target = console) {
  if (target._pmjsRawConsole) return;
  const levels = { log: 'INFO', info: 'INFO', debug: 'INFO', warn: 'WARN', error: 'ERROR' };
  const raw = {};
  for (const method of Object.keys(levels)) raw[method] = target[method].bind(target);
  Object.defineProperty(target, '_pmjsRawConsole', { value: raw });
  for (const [method, level] of Object.entries(levels)) {
    target[method] = (...args) => {
      const prefix = `${new HostDate().toISOString()} ${level} `;
      raw[method](format(...args).replace(/\r\n?/g, '\n').split('\n')
        .map(line => prefix + line).join('\n'));
    };
  }
}

module.exports = { installConsoleLogging };
