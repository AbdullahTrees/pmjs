#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { assetIndexArtifacts } = require('../runner/asset-index.cjs');

try {
  if (process.argv.length !== 3) throw new Error('usage: verify-asset-index.cjs INDEX.json');
  const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(assetIndexArtifacts(index)) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
