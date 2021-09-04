const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const utils = require('./utils.js');

async function checkIssues(octokit, context, project) {
  core.startGroup('Checking issues...');
  core.info('');

  const funIssues = await utils.getIssues(octokit, context, project, 'functionality');

  const funPassed = funIssues.find(x => x.state == 'closed' && x.locked == true && x.active_lock_reason == 'resolved');

  if (!funPassed) {
    throw new Error(`Unable to detect approved functionality issue for project ${project}. You must pass functionality before requesting code review.`);
  }

  core.info(`Passing functionality issue: ${funPassed.html_url}`);
  core.info('');

  const desIssues = await utils.getIssues(octokit, context, project, 'design');

  const desPassed = desIssues.find(x => x.state == 'closed' && x.locked == true && x.active_lock_reason == 'resolved');

  if (desPassed) {
    core.info(`Passing design issue: ${desPassed.html_url}`);
    throw new Error(`Detected approved design issue #${desPassed.number} for project ${project}. Additional code reviews are not necessary.`);
  }

  core.info(`No passing design issues for project ${project} found.`);

  const syncPulls = await utils.getIssues(octokit, context, project, 'synchronous');

  const asyncPulls = await utils.getIssues(octokit, context, project, 'asynchronous');

  const pulls = syncPulls.concat(asyncPulls);

  const openPull = pulls.find(x => x.state == 'open' && 'pull_request' in x && 'html_url' in x.pull_request);

  if (openPull) {
    core.info(`Found open pull requests: ${JSON.stringify(openPull)}`);
    throw new Error(`Detected open pull request #${openPull.number} for project ${project}. Please merge or close old pull requests before requesting code review.`);
  }

  core.info('');
  core.endGroup();

  return {
    issueNumber: funPassed.number,
    issueUrl: funPassed.html_url
  };
}

async function cloneProject(token, context, release) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  core.startGroup(`Cloning ${release} of ${repo}...`);

  await utils.checkExec('git', {
    param: ['clone', '--depth', '1', '--no-tags', `https://github-actions:${token}@github.com/${owner}/${repo}`, utils.mainDir],
    title: `Cloning ${repo} into ${utils.mainDir}`,
    error: `Failed cloning ${repo} repository`
  });

  await utils.checkExec('ls', {
    param: ['-m', `${utils.mainDir}/src/main/java`],
    title: 'Listing project main code',
    error: 'Unable to list test directory'
  });

  core.info('');
  core.endGroup();
}

async function prepareBranch(token, context, release) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  core.startGroup(`Preparing ${release} branch...`);

  await utils.checkExec('git', {
    param: ['fetch', '--unshallow', '--tags'],
    title: 'Fetching commit history and tags',
    error: 'Unable to fetch history and tags',
    chdir: utils.mainDir
  });

  await utils.checkExec('git', {
    param: ['diff', '--shortstat', 'origin/main', release],
    title: 'Checking main branch and release are even',
    error: 'Unable compare main branch and release',
    chdir: utils.mainDir
  });

  const changed = await utils.checkExec('git', {
    param: ['diff', '--exit-code', '--quiet', 'origin/main', release],
    chdir: utils.mainDir
  });

  if (changed != 0) {
    throw new Error(`The main branch has one or more commits since release ${release} was created. There must be no changes since the last verified release for code review.`);
  }

  await utils.checkExec('git', {
    param: ['config', 'user.name', 'github-actions'],
    title: 'Configuring github action user',
    error: 'Unable to configure github action user',
    chdir: utils.mainDir,
  });

  await utils.checkExec('git', {
    param: ['config', 'user.email', 'github-actions@github.com'],
    title: 'Configuring github action email',
    error: 'Unable to configure github action email',
    chdir: utils.mainDir,
  });

  await utils.checkExec('git', {
    param: ['checkout', '-b', `review/${release}`],
    title: 'Creating review branch',
    error: 'Unable to create review branch',
    chdir: utils.mainDir,
  });

  core.info('');
  core.endGroup();

  return `review/${release}`;
}

async function run() {
  const status = {}; // status of intermediate steps
  const states = {}; // things to remember between pre/main/post

  const token = core.getInput('token');
  core.setSecret(token);

  const octokit = github.getOctokit(token);

  try {
    // get project details from release
    const release = core.getInput('release');
    const parsed = utils.parseProject(github.context, release);
    Object.assign(states, parsed);

    // check release is valid and verified
    const verified = await utils.verifyRelease(octokit, github.context, states.version);

    states.releaseUrl  = verified.release.html_url;
    states.releaseTag  = verified.release.tag_name;
    states.releaseDate = verified.release.created_at;

    states.runNumber = verified.workflow.run_number;
    states.runId  = verified.workflow.id;
    states.runUrl = verified.workflow.html_url;

    // check functionality issue for project exists
    const issues = await checkIssues(octokit, github.context, states.project);
    Object.assign(states, issues);

    // clone project repository
    await cloneProject(token, github.context, states.version);

    // setup review branch
    const branch = await prepareBranch(token, github.context, states.version);
    states.branch = branch;

    // setup maven cache
    const cache = await utils.cacheMaven(utils.mainDir);
    Object.assign(states, cache);

    // save states
    utils.saveStates(states);
  }
  catch (error) {
    utils.showError(`${error.message}\n`); // show error in group
    core.endGroup();  // end group

    // displays outside of group; always visible
    core.setFailed(`Setup failed. ${error.message}`);
  }
  finally {
    core.startGroup('Logging setup status...');
    core.info(`status: ${JSON.stringify(status)}`);
    core.info(`states: ${JSON.stringify(states)}`);
    core.endGroup();

    utils.checkWarnings('"Pre Request Review"');
  }
}

run();
