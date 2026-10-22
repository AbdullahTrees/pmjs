'use strict';

// These suites keep their own fresh VM contexts and do not mutate process or
// shared fixture state, so the full JS run can share one Node test worker.
require('./canvas-ellipse.test.cjs');
require('./canvas-gradients.test.cjs');
require('./canvas-invalid-state.test.cjs');
require('./canvas-content-revision.test.cjs');
