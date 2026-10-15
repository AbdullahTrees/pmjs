'use strict';

const sessionProcess = process;
require('./logging.cjs').installConsoleLogging();
const { run } = require('./index.cjs');
sessionProcess.once('message', async options => {
  try {
    const result = await run({ ...options, supervised: true });
    sessionProcess.send({ type: 'pmjs-session-complete', reload: !!(result && result.reload) }, error => {
      if (error) console.error(error);
      sessionProcess.exit(error ? 1 : 0);
    });
  } catch (error) {
    console.error(error && error.stack || error);
    sessionProcess.exit(1);
  }
});
