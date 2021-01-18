/**
 * @copyright Copyright 2016-2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const fetchCiStatus = require('./lib/fetch-ci-status.js');
const { resolveCommit } = require('./lib/git-utils.js');
const { getProjectName } = require('./lib/github-utils.js');

// Use same "severity" as hub(1) for determining state
// https://github.com/github/hub/blob/v2.14.2/commands/ci_status.go#L60-L69
const stateBySeverity = [
  'neutral',
  'success',
  'pending',
  'cancelled',
  'timed_out',
  'action_required',
  'failure',
  'error',
];

function getStateMarker(state, useColor) {
  function colorize(string, code) {
    return useColor ? `\u001B[${code}m${string}\u001B[39m` : string;
  }

  // Use same status markers as `hub ci-status`
  // https://github.com/github/hub/blob/v2.14.2/commands/ci_status.go#L158-L171
  switch (state) {
    case 'success':
      return colorize('✔︎', 32);

    case 'action_required':
    case 'cancelled':
    case 'error':
    case 'failure':
    case 'timed_out':
      return colorize('✖︎', 31);

    case 'neutral':
      return colorize('◦', 30);

    case 'pending':
      return colorize('●', 33);

    default:
      return '';
  }
}

function formatStatus(status, contextWidth, useColor) {
  const stateMarker = getStateMarker(status.state, useColor);
  const context = status.context.padEnd(contextWidth);
  const targetUrl = status.target_url ? `\t${status.target_url}` : '';
  return `${stateMarker}\t${context}${targetUrl}`;
}

function formatStatuses(statuses, useColor) {
  // If no status has a target_url, there's no need to size context
  const contextWidth = !statuses.some((status) => status.target_url) ? 0
    : statuses.reduce(
      (max, { context }) => Math.max(max, context.length),
      0,
    );
  return statuses
    .map((status) => formatStatus(status, contextWidth, useColor))
    .join('\n');
}

function getState(statuses) {
  const bestSeverity = statuses.reduce((maxSeverity, status) => {
    const severity = stateBySeverity.indexOf(status.state);
    return Math.max(severity, maxSeverity);
  }, -1);
  return stateBySeverity[bestSeverity] || '';
}

function stateToExitCode(state) {
  // Use same exit codes as `hub ci-status`
  // https://github.com/github/hub/blob/v2.14.2/commands/ci_status.go#L115-L125
  switch (state) {
    case 'neutral':
    case 'success':
      return 0;

    case 'action_required':
    case 'cancelled':
    case 'error':
    case 'failure':
    case 'timed_out':
      return 1;

    case 'pending':
      return 2;

    default:
      return 3;
  }
}

/** Converts a "check_run" object from the Checks API to a "statuses" object
 * from the CI Status API.
 *
 * https://docs.github.com/rest/reference/checks#list-check-runs-for-a-git-reference
 * https://docs.github.com/rest/reference/repos#get-the-combined-status-for-a-specific-reference
 *
 * @private
 * @param {!object} checkRun "check_run" object from Checks API response.
 * @returns {!object} "statuses" object from CI Status API response.
 */
function checkRunToStatus(checkRun) {
  // Based on mapping done by hub(1)
  // https://github.com/github/hub/blob/v2.14.2/github/client.go#L543-L551
  return {
    state: checkRun.status === 'completed' ? checkRun.conclusion : 'pending',
    context: checkRun.name,
    target_url: checkRun.html_url,  // eslint-disable-line camelcase
  };
}

module.exports =
async function githubCiStatus(ref, options = {}) {
  const [[owner, repo], sha] = await Promise.all([
    getProjectName(),
    resolveCommit(ref),
  ]);
  const statusOptions = {
    auth: options.auth,
    wait: options.wait,
  };
  if (options.verbosity > 1) {
    statusOptions.debug = (msg) => options.stderr.write(`DEBUG: ${msg}\n`);
  }
  const [combinedStatus, checksList] =
    await fetchCiStatus(owner, repo, sha, statusOptions);

  const statuses = [
    ...combinedStatus.statuses,
    ...checksList.check_runs.map(checkRunToStatus),
  ];
  const state = getState(statuses);
  if (options.verbosity >= 0) {
    const useColor = options.useColor === false ? false
      : options.useColor === true ? true
        : options.stdout.isTTY;
    const formatted = options.verbosity === 0 ? state
      : formatStatuses(statuses, useColor);
    options.stdout.write(`${formatted || 'no status'}\n`);
  }

  return stateToExitCode(state);
};
