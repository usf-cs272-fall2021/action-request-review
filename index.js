const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const utils = require('./utils.js');
var { DateTime } = require('luxon');

async function run() {
  const status = {}; // status of intermediate steps
  const states = {}; // things to remember between pre/main/post

  const token = core.getInput('token');
  core.setSecret(token);

  const octokit = github.getOctokit(token);

  try {
    utils.showTitle('Request Setup Phase');

    // must do or setup state is lost
    utils.restoreStates(states);

    // -----------------------------------------------
    core.startGroup('Displaying environment setup...');

    await utils.checkExec('java', {
      param: ['--version'],
      title: 'Displaying Java runtime version',
      error: 'Unable to display Java runtime version'
    });

    await utils.checkExec('javac', {
      param: ['--version'],
      title: 'Displaying Java compiler version',
      error: 'Unable to display Java compiler version'
    });

    await utils.checkExec('mvn', {
      param: ['--version'],
      title: 'Displaying Maven version',
      error: 'Unable to display Maven version'
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    utils.showTitle('Request Verify Phase');

    // -----------------------------------------------
    core.startGroup('Checking code for warnings...');

    status.mainCompile = await utils.checkExec('mvn', {
      param: ['-ntp', '"-DcompileOptionXlint=-Xlint:all"', '"-DcompileOptionXdoclint=-Xdoclint:all/private"', '-DcompileOptionFail=true', '-Dmaven.compiler.failOnWarning=true', '-Dmaven.compiler.showWarnings=true', 'clean', 'compile'],
      title: 'Compiling project code',
      error: 'Unable to compiling code without warnings. Please address all warnings before requesting code review',
      chdir: `${utils.mainDir}/`
    });

    await utils.checkExec('ls', {
      param: ['-m', `${utils.mainDir}/target/classes`],
      title: 'Listing main class files',
      error: 'Unable to list main class directory',
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup('Checking code for cleanup...');

    status.todoGrep = await utils.checkExec('grep', {
      param: ['-rnoiE', '^\\s*[/*]{1,2}.*\\bTODO\\b', '.'],
      title: 'Checking for 1 line TODO comments',
      chdir: `${utils.mainDir}/src/main/java`
    });

    if (status.todoGrep != 1) {
      throw new Error('One or more TODO comments found. Please clean up the code before requesting code review.');
    }

    status.mainGrep = await utils.checkExec('grep', {
      param: ['-rnoiE', '--exclude=Driver.java', '\\s*public\\s+static\\s+void\\s+main\\s*\\(', '.'],
      title: 'Checking for extra main methods',
      chdir: `${utils.mainDir}/src/main/java`
    });

    if (status.mainGrep != 1) {
      throw new Error('More than one main method found. Please clean up old main methods before requesting code review.');
    }

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    utils.showTitle('Request Approve Phase');

    // -----------------------------------------------
    core.startGroup('Creating code review branch...');

    status.branchCommit = await utils.checkExec('git', {
      param: ['commit', '--allow-empty', '-m', `"Creating ${states.branch} branch"`],
      title: 'Creating branch commit',
      error: `Unable to commit ${states.branch} branch`,
      chdir: `${utils.mainDir}/`
    });

    status.branchPush = await utils.checkExec('git', {
      param: ['push', '-u', 'origin', states.branch],
      title: 'Pushing branch to remote',
      error: `Unable to push ${states.branch} branch. Please make sure this branch does not already exist`,
      chdir: `${utils.mainDir}/`
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup('Creating pull request...');
    core.info('');

    const milestone = await utils.getMilestone(octokit, github.context, states.project);

    core.info('');
    const pulls = await utils.getPullRequests(octokit, github.context, states.project);

    let reviewList = 'N/A';
    const zone = 'America/Los_Angeles';

    core.info('');
    core.info('Creating pull request...');

    if (pulls.length > 0) {
      let rows = [
        '| Pull | Status | Labels | Approvals | Created | Closed |',
        '|:----:|:------:|:-------|:----------|:--------|:-------|'
      ];

      let sorter = function(x, y) {
        // project first
        if (x.name.startsWith('project')) {
          return -1;
        }

        if (y.name.startsWith('project')) {
          return 1;
        }

        // tag next
        if (x.name.startsWith('v')) {
          return -1;
        }

        if (y.name.startsWith('v')) {
          return 1;
        }

        // then whatever is left
        if (x.name < y.name) {
          return -1;
        }

        if (x.name > y.name) {
          return -1;
        }

        return 0;
      }

      for (const pull of pulls) {
        const status = pull.draft ? 'draft' : pull.state;
        const labels = pull.labels ? pull.labels.sort(sorter).map(x => x.name).join(', ') : 'N/A';
        const createdDate = pull.created_at ? DateTime.fromISO(pull.created_at).setZone(zone).toLocaleString(DateTime.DATETIME_FULL) : 'N/A';
        const closedDate = pull.closed_at ? DateTime.fromISO(pull.closed_at).setZone(zone).toLocaleString(DateTime.DATETIME_FULL) : 'N/A';

        // const reviewers = pull.requested_reviewers ? pull.requested_reviewers.map(x => `@${x.login}`).join(', ') : 'N/A';

        // https://docs.github.com/en/rest/reference/pulls#list-reviews-for-a-pull-request
        // https://octokit.github.io/rest.js/v18#pulls-list-reviews
        const reviews = await octokit.pulls.listReviews({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: pull.number
        });

        const approved = reviews.data.filter(x => x.state == "APPROVED");
        const approvals = approved.map(x => `${x.user.login}`).join(', ');

        rows.push(`| [#${pull.number}](${pull.html_url}) | ${status} | ${labels} | ${approvals} | ${createdDate} | ${closedDate} |`);
      }

      reviewList = rows.join('\n');
    }

    const body = `
## Student Information

- **Full Name:** [FULL_NAME]
- **USF Email:** [USF_EMAIL]@usfca.edu

## Project Information

- **Project:** [Project ${states.project} ${utils.projectNames[+states.project]}](https://usf-cs272-fall2021.github.io/guides/projects/project-${states.project}.html)
- **Project Functionality:** [Issue #${states.issueNumber}](${states.issueUrl})

## Release Information

- **Release:** [${states.releaseTag}](${states.releaseUrl})
- **Release Verified:** [Run ${states.runNumber} (${states.runId})](${states.runUrl})
- **Release Created:** ${DateTime.fromISO(states.releaseDate).setZone(zone).toLocaleString(DateTime.DATETIME_FULL)}

## Request Details

- **Review Type:** ${states.type}

#### Previous Pull Requests

${reviewList}

    `;

    const data = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      title: `Project ${states.releaseTag} ${states.type} Code Review`,
      head: states.branch,
      base: 'main',
      body: body,
      draft: true,
      maintainer_can_modify: true
    };

    const pullRequest = await octokit.pulls.create(data);

    if (pullRequest.status != 201) {
      core.info(`Request: ${JSON.stringify(data)}`);
      core.info(`Result: ${JSON.stringify(pullRequest)}`);
      throw new Error(`Unable to create pull request for: ${github.context.repo.repo}`);
    }

    core.info(`Pull request created at: ${pullRequest.data.html_url}`);

    core.info('');
    core.info(`Updating pull request ${pullRequest.data.number}...`);

    // https://docs.github.com/en/rest/reference/issues#update-an-issue
    const update = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: pullRequest.data.number,
      milestone: milestone.number,
      labels: [`project${states.project}`, states.type.toLowerCase(), states.releaseTag],
      assignees: [github.context.actor]
    };

    const updateRequest = await octokit.issues.update(update);

    if (updateRequest.status != 200) {
      core.info(`Request: ${JSON.stringify(update)}`);
      core.info(`Result: ${JSON.stringify(updateRequest)}`);
      throw new Error(`Unable to update labels for pull request at: ${pullRequest.data.html_url}`);
    }

    core.info(`Added labels: ${update.labels.join(', ')}`);

    // add reviewers to pull request
    const reviewers = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: pullRequest.data.number,
      reviewers: ['mtquach2', 'ybsolomon']
    };

    const reviewRequest = await octokit.pulls.requestReviewers(reviewers);

    if (reviewRequest.status != 201) {
      core.info(`Request: ${JSON.stringify(reviewers)}`);
      core.info(`Result: ${JSON.stringify(reviewRequest)}`);
      throw new Error(`Unable to request reviewers for pull request at: ${pullRequest.data.html_url}`);
    }

    core.info(`Added reviewers: ${reviewers.reviewers.join(', ')}`);

    // add instructions as a comment
    const comment = `
## Student Instructions

Hello @${github.context.actor}! Please follow these instructions to request your project ${states.releaseTag} ${states.type.toLowerCase()} code review:

- [ ] Replace \`[FULL_NAME]\` with your full name and \`[USF_EMAIL]\` with your USF username so we can enter your grade on Canvas.

- [ ] Double-check the [labels, assignee, and milestone](https://guides.github.com/features/issues/) are set properly.

- [ ] Double-check you are making the correct type of request. You can only request an asynchronous code review if you were pre-approved by the instructor!

- [ ] **Mark this request as "Ready to Review" when all of the above is complete.**

Click each of the above tasks as you complete them!

We will reply with further instructions. If we do not respond within 2 *business* days, please reach out on CampusWire.

:warning: **We will not see this request while it is in draft mode. You must mark it as ready to review first!**
    `;

    const commentRequest = await octokit.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: pullRequest.data.number,
      body: comment
    });

    if (commentRequest.status != 201) {
      core.info(`Result: ${JSON.stringify(commentRequest)}`);
      throw new Error(`Unable to add comment for pull request at: ${pullRequest.data.html_url}`);
    }

    core.info(`Added instructions for: ${github.context.actor}`);

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    const success = `${states.type} code review request #${pullRequest.data.number} for project ${states.project} release ${states.releaseTag} created. Visit the pull request for further instructions at: ${pullRequest.data.html_url}`;

    utils.showSuccess(success);
    core.notice(success);
  }
  catch (error) {
    utils.showError(`${error.message}\n`); // show error in group
    core.endGroup();  // end group

    // displays outside of group; always visible
    core.setFailed(`Code review request failed. ${error.message}`);
  }
  finally {
    core.startGroup('Logging setup status...');
    core.info(`status: ${JSON.stringify(status)}`);
    core.info(`states: ${JSON.stringify(states)}`);
    core.endGroup();

    utils.checkWarnings('"Request Review"');
  }
}

run();
