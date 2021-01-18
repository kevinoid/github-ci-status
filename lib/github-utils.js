/**
 * @copyright Copyright 2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const { debuglog } = require('util');

const { getBranch, getConfig, parseGitUrl } = require('./git-utils.js');

const debug = debuglog('github-ci-status');

// Additional FQDN to treat as GitHub.  As in hub(1):
// https://github.com/github/hub/blob/v2.14.2/github/hosts.go#L13
const gitHubHostEnv = process.env.GITHUB_HOST;

// Origin lookup order used by hub(1):
// https://github.com/github/hub/blob/v2.14.2/github/remote.go#L13
const originNamesInLookupOrder = [
  'upstream',
  'github',
  'origin',
];

function getRemoteUrls(config, branchRemote) {
  const remotes = Object.entries(config)
    .map(([key, value]) => {
      const match = /^remote\.(.*)\.((?:push)?url)$/.exec(key);
      return match && {
        name: match[1],
        isPush: match[2] === 'pushurl',
        url: value,
      };
    })
    .filter(Boolean);

  remotes.sort((remote1, remote2) => {
    const name1 = remote1.name;
    const name2 = remote2.name;

    // Sort remote for current branch before others
    const isBranch1 = name1 === branchRemote;
    const isBranch2 = name2 === branchRemote;
    if (isBranch1 !== isBranch2) {
      return isBranch1 ? -1 : 1;
    }

    // Sort known remote names before others
    const order1 = originNamesInLookupOrder.indexOf(name1);
    const order2 = originNamesInLookupOrder.indexOf(name2);
    if (order1 !== order2) {
      return order1 === -1 ? 1
        : order2 === -1 ? -1
          : order1 - order2;
    }

    // Sort lexicographically by remote name
    if (name1 !== name2) {
      return name1 < name2 ? -1 : 1;
    }

    // Sort push first
    if (remote1.isPush !== remote2.isPush) {
      return remote1.isPush ? -1 : 1;
    }

    throw new Error(
      `Duplicate config 'remote.${name1}.${remote1.isPush ? 'push' : ''}url'`,
    );
  });

  return remotes.map((remote) => remote.url);
}

function getGitHubUrls(config, branchRemote) {
  const gitHubUrls = getRemoteUrls(config, branchRemote)
    .map((remoteUrl) => {
      try {
        const parsed = parseGitUrl(remoteUrl);
        if (parsed.hostname === 'github.com'
          || parsed.hostname === gitHubHostEnv
          || parsed.hostname.endsWith('.github.com')) {
          return parsed;
        }
      } catch (err) {
        debug('Error parsing remote URL <%s>: %o', remoteUrl, err);
      }
      return undefined;
    })
    .filter(Boolean);

  return new Set(gitHubUrls);
}

async function tryGetBranch() {
  try {
    return await getBranch();
  } catch (errBranch) {
    debug('Unable to get current branch name: %o', errBranch);
    return undefined;
  }
}

/** Get the GitHub owner and repo name for the git repository of the working
 * directory.
 *
 * @private
 * @returns {!Promise<!Array<string>>} Promise for the owner and repo name,
 * as Array elements, or an Error if they can not be determined.
 */
exports.getProjectName =
async function getProjectName() {
  // Run getBranch() and getConfig() concurrently.
  const [branch, config] = await Promise.all([
    tryGetBranch(),
    getConfig('local'),
  ]);

  const branchRemote = branch && config[`branch.${branch}.remote`];
  if (branch && !branchRemote) {
    debug(`No remote configured for current branch (${branch})`);
  }

  for (const remoteUrl of getGitHubUrls(config, branchRemote)) {
    const pathParts = remoteUrl.pathname.split('/');
    if (pathParts.length !== 3
      || pathParts[0]
      || !pathParts[1]
      || !pathParts[2]) {
      debug(
        'Skipping GitHub URL <%s>: Need exactly 2 non-empty path segments.',
        remoteUrl,
      );
    } else {
      let repo = pathParts[2];
      if (repo.endsWith('.git')) {
        repo = repo.slice(0, -4);
      }

      if (!repo) {
        debug('Skipping GitHub URL <%s>: Empty repo name.', remoteUrl);
      } else {
        return [pathParts[1], repo];
      }
    }
  }

  throw new Error('Unable to determine GitHub project name: '
    + 'No GitHub remote URLs recognized.');
};