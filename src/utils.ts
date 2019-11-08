import { Application, Context } from 'probot';
import * as GitHub from '@octokit/rest';
import fetch from 'node-fetch';
import * as fs from 'fs-extra';
import { IQueue } from 'queue';
import * as simpleGit from 'simple-git/promise';

import { PullRequest } from './Probot';
import queue from './Queue';
import { CHECK_PREFIX } from './constants';
import { PRStatus, BackportPurpose } from './enums';

import * as labelUtils from './utils/label-utils';
import { initRepo } from './operations/init-repo';
import { setupRemotes } from './operations/setup-remotes';
import { backportCommitsToBranch } from './operations/backport-commits';
import { getRepoToken } from './utils/token-util';

const makeQueue: IQueue = require('queue');
const { parse: parseDiff } = require('what-the-diff');

export const defaultBranch = (context: Context) => {
  return context.payload.repository.default_branch || 'master';
};

export const labelMergedPR = async (context: Context, pr: PullRequest, targetBranch: String) => {
  const prMatch = pr.body.match(/#[0-9]{1,7}/);
  if (prMatch && prMatch[0]) {
    const prNumber = parseInt(prMatch[0].substring(1), 10);

    const labelToAdd = PRStatus.MERGED + targetBranch;
    const labelToRemove = PRStatus.IN_FLIGHT + targetBranch;

    await labelUtils.removeLabel(context, prNumber, labelToRemove);
    await labelUtils.addLabel(context, prNumber, [labelToAdd]);
  }
};

const createBackportComment = (pr: PullRequest) => {
  let body = `Backport of #${pr.number}\n\nSee that PR for details.`;

  const onelineMatch = pr.body.match(/(?:(?:\r?\n)|^)notes: (.+?)(?:(?:\r?\n)|$)/gi);
  const multilineMatch =
      pr.body.match(/(?:(?:\r?\n)Notes:(?:\r?\n)((?:\*.+(?:(?:\r?\n)|$))+))/gi);

  // attach release notes to backport PR body
  if (onelineMatch && onelineMatch[0]) {
    body += `\n\n${onelineMatch[0]}`;
  } else if (multilineMatch && multilineMatch[0]) {
    body += `\n\n${multilineMatch[0]}`;
  } else {
    body += '\n\nNotes: no-notes';
  }

  return body;
};

export const backportImpl = async (robot: Application,
                                   context: Context,
                                   targetBranch: string,
                                   purpose: BackportPurpose,
                                   labelToRemove?: string,
                                   labelToAdd?: string) => {
  const base: GitHub.PullsGetResponseBase = context.payload.pull_request.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const bp = `backport from PR #${context.payload.pull_request.number} to "${targetBranch}"`;
  robot.log(`Queuing ${bp} for "${slug}"`);

  const log = (...args: string[]) => robot.log(slug, ...args);

  const getCheckRun = async () => {
    const allChecks = await context.github.checks.listForRef(context.repo({
      ref: context.payload.pull_request.head.sha,
      per_page: 100,
    }));

    return allChecks.data.check_runs.find((run: GitHub.ChecksListForRefResponseCheckRunsItem) => {
      return run.name === `${CHECK_PREFIX}${targetBranch}`;
    });
  };

  let createdDir: string | null = null;

  queue.enterQueue(
    `backport-${context.payload.pull_request.head.sha}-${targetBranch}-${purpose}`,
    async () => {
      log(`Executing ${bp} for "${slug}"`);
      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          await context.github.checks.update(context.repo({
            check_run_id: checkRun.id,
            name: checkRun.name,
            status: 'in_progress' as 'in_progress',
          }));
        }
      }

      log('getting repo access token');
      const repoAccessToken = await getRepoToken(robot, context);

      // use GHE_HOST
      const githubHost = process.env.GHE_HOST || 'github.com';
      const githubAPIBaseUrl = process.env.GHE_HOST ? `https://${process.env.GHE_HOST}/api/v3` : 'https://api.github.com';
      const pr = context.payload.pull_request as any as PullRequest;
      // Set up empty repo on master
      log('Setting up local repository');
      const { dir } = await initRepo({
        githubHost,
        slug,
        accessToken: repoAccessToken,
        defaultBranch: defaultBranch(context),
      });
      createdDir = dir;
      log(`Working directory cleaned: ${dir}`);

      // Set up remotes
      log('setting up remotes');
      const targetRepoRemote =
          `https://x-access-token:${repoAccessToken}@${githubHost}/${slug}.git`;

      await setupRemotes({
        dir,
        remotes: [{
          name: 'target_repo',
          value: targetRepoRemote,
        }],
      });

      // Get list of commits
      log(`Getting rev list from: ${pr.base.sha}..${pr.head.sha}`);
      const commits = (await context.github.pulls.listCommits(context.repo({
        number: pr.number,
      }))).data.map((commit: GitHub.PullsListCommitsResponseItem) => commit.sha!);

      // No commits == WTF
      if (commits.length === 0) {
        log('Found no commits to backport, aborting');
        return;
      }

      // Over 240 commits is probably the limit from github so let's not bother
      if (commits.length >= 240) {
        log(`Too many commits (${commits.length})...backport will not be performed.`);
        await context.github.issues.createComment(context.repo({
          number: pr.number,
          body: 'This PR has exceeded the automatic backport commit limit \
    and must be performed manually.',
        }));

        return;
      }

      log(`Found ${commits.length} commits to backport, requesting details now.`);
      const patches: string[] = (new Array(commits.length)).fill('');
      const q = makeQueue({
        concurrency: 5,
      });
      q.stop();

      for (const [i, commit] of commits.entries()) {
        q.push(async () => {
          const patchUrl = `${githubAPIBaseUrl}/repos/${slug}/commits/${commit}`;
          const patchBody = await fetch(patchUrl, {
            headers: {
              Accept: 'application/vnd.github.VERSION.patch',
              Authorization: `token ${repoAccessToken}`,
            },
          });
          patches[i] = await patchBody.text();
          log(`Got patch (${i + 1}/${commits.length})`);
        });
      }

      await new Promise(r => q.start(r));
      log('Got all commit info');

      // Temp branch
      const sanitizedTitle = pr.title
        .replace(/\*/g, 'x').toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-');
      const tempBranch = `trop/${targetBranch}-bp-${sanitizedTitle}-${Date.now()}`;

      log(`Checking out target: "target_repo/${targetBranch}" to temp: "${tempBranch}"`);
      log('Will start backporting now');

      await backportCommitsToBranch({
        dir,
        slug,
        targetBranch,
        tempBranch,
        patches,
        targetRemote: 'target_repo',
        shouldPush: purpose === BackportPurpose.ExecuteBackport,
      });

      log('Cherry pick success, pushed up to target_repo');

      if (purpose === BackportPurpose.ExecuteBackport) {
        log('Creating Pull Request');
        const newPr = (await context.github.pulls.create(context.repo({
          head: `${tempBranch}`,
          base: targetBranch,
          title: pr.title,
          body: createBackportComment(pr),
          maintainer_can_modify: false,
        }))).data;

        log('Adding breadcrumb comment');
        await context.github.issues.createComment(context.repo({
          number: pr.number,
          body: `I have automatically backported this PR to "${targetBranch}", \
    please check out #${newPr.number}`,
        }));

        if (labelToRemove) {
          log(`Removing label '${labelToRemove}'`);
          await labelUtils.removeLabel(context, pr.number, labelToRemove);
        }

        if (labelToAdd) {
          log(`Adding label '${labelToAdd}'`);
          await labelUtils.addLabel(context, pr.number, [labelToAdd]);
        }

        await labelUtils.addLabel(context, newPr.number!, ['backport', `${targetBranch}`]);

        log('Backport complete');
      }

      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          context.github.checks.update(context.repo({
            check_run_id: checkRun.id,
            name: checkRun.name,
            conclusion: 'success' as 'success',
            completed_at: (new Date()).toISOString(),
            output: {
              title: 'Clean Backport',
              summary: `This PR was checked and can be backported to "${targetBranch}" cleanly.`,
            },
          }));
        }
      }

      await fs.remove(createdDir);
    },
    async () => {
      let annotations: any[] | null = null;
      let diff;
      let rawDiff;
      if (createdDir) {
        const git = simpleGit(createdDir);
        rawDiff = await git.diff();
        diff = parseDiff(rawDiff);

        annotations = [];
        for (const file of diff) {
          if (file.binary) continue;

          for (const hunk of (file.hunks || [])) {
            const startOffset = hunk.lines.findIndex((line: string) => line.includes('<<<<<<<'));
            const endOffset = hunk.lines.findIndex((line: string) => line.includes('=======')) - 2;
            const finalOffset = hunk.lines.findIndex((line: string) => line.includes('>>>>>>>'));
            annotations.push({
              path: file.filePath,
              start_line: hunk.theirStartLine + Math.max(0, startOffset),
              end_line: hunk.theirStartLine + Math.max(0, endOffset),
              annotation_level: 'failure',
              message: 'Patch Conflict',
              raw_details: hunk.lines.filter((_: any, i: number) => i >= startOffset && i <= finalOffset).join('\n'),
            });
          }
        }

        await fs.remove(createdDir);
      }

      const pr = context.payload.pull_request;
      if (purpose === BackportPurpose.ExecuteBackport) {
        await context.github.issues.createComment(context.repo({
          number: pr.number,
          body: `I was unable to backport this PR to "${targetBranch}" cleanly;
   you will need to perform this backport manually.`,
        }) as any);

        const labelToRemove = PRStatus.TARGET + targetBranch;
        await labelUtils.removeLabel(context, pr.number, labelToRemove);

        const labelToAdd = PRStatus.NEEDS_MANUAL + targetBranch;
        await labelUtils.addLabel(context, pr.number, [labelToAdd]);
      }

      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          const mdSep = '``````````````````````````````';
          const updateOpts: GitHub.ChecksUpdateParams = context.repo({
            check_run_id: checkRun.id,
            name: checkRun.name,
            conclusion: 'neutral' as 'neutral',
            completed_at: (new Date()).toISOString(),
            output: {
              title: 'Backport Failed',
              summary: `This PR was checked and could not be automatically backported to "${targetBranch}" cleanly`,
              text: diff ? `Failed Diff:\n\n${mdSep}diff\n${rawDiff}\n${mdSep}` : undefined,
              annotations: annotations ? annotations : undefined,
            },
          });
          try {
            await context.github.checks.update(updateOpts as any);
          } catch (err) {
            // A github error occurred, let's try mark it as a failure without annotations
            updateOpts.output!.annotations = undefined;
            await context.github.checks.update(updateOpts as any);
          }
        }
      }
    },
  );
};
