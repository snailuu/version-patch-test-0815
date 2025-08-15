import * as core from '@actions/core';

export const logger = {
  debug: core.debug,
  info: core.info,
  warning: core.warning,
  error: core.error,
};

export default core;
