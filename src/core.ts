import { debug, error, info, warning } from '@actions/core';

export { getBooleanInput, getInput, setFailed, setOutput } from '@actions/core';

export const logger = {
  debug,
  error,
  info,
  warning,
};
