import * as fs from 'fs-extra';
import * as simpleGit from 'simple-git/promise';

export interface BackportOptions {
  dir: string;
  slug: string;
  targetRemote: string;
  targetBranch: string;
  tempBranch: string;
  patches: string[];
  shouldPush: boolean;
}

/*
* Runs the git commands to apply backports in a series of cherry-picked commits.
*
* @param {BackportOptions} - an object containing:
* 1) dir - the repo directory,
* 2) targetBranch - the target branch
* 3) patches - a list of patches to apply to the target branch
* 3) tempBranch - the temporary branch to PR against the target branch
* @returns {Object} - an object containing the repo initialization directory
*/
export const backportCommitsToBranch = async (options: BackportOptions) => {
  const git = simpleGit(options.dir);
  // Create branch
  await git.checkout(`target_repo/${options.targetBranch}`);
  await git.pull('target_repo', options.targetBranch);
  await git.checkoutBranch(options.tempBranch, `target_repo/${options.targetBranch}`);

  // Cherry pick
  const patchPath = `${options.dir}.patch`;
  for (const patch of options.patches) {
    await fs.writeFile(patchPath, patch, 'utf8');
    await git.raw(['am', '-3', patchPath]);
    await fs.remove(patchPath);
  }

  // Push
  if (options.shouldPush) {
    await git.push(options.targetRemote, options.tempBranch, {
      '--set-upstream': true,
    });
  }
  return { dir: options.dir };
};
