import { DateTime } from 'luxon';
import { readFile } from 'fs-extra';
import is from '@sindresorhus/is';
import minimatch from 'minimatch';
import { join } from 'upath';
import { logger } from '../../logger';
import { isScheduledNow } from './schedule';
import { getUpdatedPackageFiles } from './get-updated';
import {
  getAdditionalFiles,
  AdditionalPackageFiles,
} from '../../manager/npm/post-update';
import { commitFilesToBranch } from './commit';
import { getParentBranch } from './parent';
import { tryBranchAutomerge } from './automerge';
import { setStability, setUnpublishable } from './status-checks';
import { prAlreadyExisted } from './check-existing';
import { ensurePr, checkAutoMerge } from '../pr';
import { RenovateConfig } from '../../config';
import { platform } from '../../platform';
import { emojify } from '../../util/emoji';
import {
  BranchConfig,
  PrResult,
  ProcessBranchResult,
  BranchResult,
} from '../common';
import {
  PLATFORM_AUTHENTICATION_ERROR,
  PLATFORM_BAD_CREDENTIALS,
  SYSTEM_INSUFFICIENT_DISK_SPACE,
  PLATFORM_INTEGRATION_UNAUTHORIZED,
  MANAGER_LOCKFILE_ERROR,
  PLATFORM_RATE_LIMIT_EXCEEDED,
  REPOSITORY_CHANGED,
  WORKER_FILE_UPDATE_FAILED,
  DATASOURCE_FAILURE,
  PLATFORM_FAILURE,
} from '../../constants/error-messages';
import {
  PR_STATE_CLOSED,
  PR_STATE_MERGED,
  PR_STATE_OPEN,
} from '../../constants/pull-requests';
import { BranchStatus } from '../../types';
import { exec } from '../../util/exec';
import { regEx } from '../../util/regex';

// TODO: proper typings
function rebaseCheck(config: RenovateConfig, branchPr: any): boolean {
  const titleRebase = branchPr.title && branchPr.title.startsWith('rebase!');
  const labelRebase =
    branchPr.labels && branchPr.labels.includes(config.rebaseLabel);
  const prRebaseChecked =
    branchPr.body && branchPr.body.includes(`- [x] <!-- rebase-check -->`);

  return titleRebase || labelRebase || prRebaseChecked;
}

export async function processBranch(
  branchConfig: BranchConfig,
  prHourlyLimitReached?: boolean,
  alreadyAutomerged?: boolean,
  packageFiles?: AdditionalPackageFiles
): Promise<ProcessBranchResult> {
  const config: BranchConfig = { ...branchConfig };
  const dependencies = config.upgrades
    .map(upgrade => upgrade.depName)
    .filter(v => v) // remove nulls (happens for lock file maintenance)
    .filter((value, i, list) => list.indexOf(value) === i); // remove duplicates
  logger.debug(
    { dependencies },
    `processBranch with ${branchConfig.upgrades.length} upgrades`
  );
  logger.trace({ config }, 'branch config');
  await platform.setBaseBranch(config.baseBranch);
  let branchExists = !!(await platform.branchExists(config.branchName));
  const branchPr = await platform.getBranchPr(config.branchName);
  const res: ProcessBranchResult = {
    branchExists,
    branchResult: branchExists
      ? BranchResult.NotUpdated
      : BranchResult.NotAttempted,
    prExists: !!branchPr,
    prResult: branchPr ? PrResult.NotUpdated : PrResult.NotAttempted,
  };
  logger.debug(`branchExists=${branchExists}`);
  const masterIssueCheck = (config.masterIssueChecks || {})[config.branchName];
  // istanbul ignore if
  if (masterIssueCheck) {
    logger.debug(
      'Branch has been checked in master issue: ' + masterIssueCheck
    );
  }
  if (branchPr) {
    config.rebaseRequested = rebaseCheck(config, branchPr);
    logger.debug(`Branch pr rebase requested: ${config.rebaseRequested}`);
  }
  try {
    logger.debug(`Branch has ${dependencies.length} upgrade(s)`);

    // Check if branch already existed
    const existingPr = branchPr ? undefined : await prAlreadyExisted(config);
    if (existingPr && !masterIssueCheck) {
      logger.debug(
        { prTitle: config.prTitle },
        'Closed PR already exists. Skipping branch.'
      );
      if (existingPr.state === PR_STATE_CLOSED) {
        const topic = `Renovate Ignore Notification`;
        let content;
        if (config.updateType === 'major') {
          content = `As this PR has been closed unmerged, Renovate will ignore this upgrade and you will not receive PRs for *any* future ${config.newMajor}.x releases. However, if you upgrade to ${config.newMajor}.x manually then Renovate will then reenable updates for minor and patch updates automatically.`;
        } else if (config.updateType === 'digest') {
          content = `As this PR has been closed unmerged, Renovate will ignore this upgrade updateType and you will not receive PRs for *any* future ${config.depName}:${config.currentValue} digest updates. Digest updates will resume if you update the specified tag at any time.`;
        } else {
          content = `As this PR has been closed unmerged, Renovate will now ignore this update (${config.newValue}). You will still receive a PR once a newer version is released, so if you wish to permanently ignore this dependency, please add it to the \`ignoreDeps\` array of your renovate config.`;
        }
        content +=
          '\n\nIf this PR was closed by mistake or you changed your mind, you can simply rename this PR and you will soon get a fresh replacement PR opened.';
        if (!config.suppressNotifications.includes('prIgnoreNotification')) {
          if (config.dryRun) {
            logger.info(
              'DRY-RUN: Would ensure closed PR comment in PR #' +
                existingPr.number
            );
          } else {
            await platform.ensureComment({
              number: existingPr.number,
              topic,
              content,
            });
          }
        }
        if (branchExists) {
          if (config.dryRun) {
            logger.info('DRY-RUN: Would delete branch ' + config.branchName);
          } else {
            await platform.deleteBranch(config.branchName);
          }
        }
      } else if (existingPr.state === PR_STATE_MERGED) {
        logger.debug(
          { pr: existingPr.number },
          'Merged PR is blocking this branch'
        );
      }
      res.branchResult = BranchResult.BlockedByClosedPr;
      return res;
    }
    // istanbul ignore if
    if (!branchExists && config.masterIssueApproval) {
      if (masterIssueCheck) {
        logger.debug(`Branch ${config.branchName} is approved for creation`);
      } else {
        logger.debug(`Branch ${config.branchName} needs approval`);
        res.branchResult = BranchResult.AwaitingApproval;
        return res;
      }
    }
    if (
      !branchExists &&
      prHourlyLimitReached &&
      !masterIssueCheck &&
      !config.vulnerabilityAlert
    ) {
      logger.debug(
        'Reached PR creation limit or per run commits limit - skipping branch creation'
      );
      res.branchResult = BranchResult.AwaitingHourlyLimit;
      return res;
    }
    if (branchExists) {
      res.branchResult = BranchResult.NotUpdated; // default
      logger.debug('Checking if PR has been edited');
      if (branchPr) {
        logger.debug('Found existing branch PR');
        if (branchPr.state !== PR_STATE_OPEN) {
          logger.debug(
            'PR has been closed or merged since this run started - aborting'
          );
          throw new Error(REPOSITORY_CHANGED);
        }
        if (
          branchPr.isModified ||
          (branchPr.targetBranch &&
            branchPr.targetBranch !== branchConfig.baseBranch)
        ) {
          const topic = 'PR has been edited';
          if (masterIssueCheck || config.rebaseRequested) {
            if (config.dryRun) {
              logger.info(
                'DRY-RUN: Would ensure PR edited comment removal in PR #' +
                  branchPr.number
              );
            } else {
              await platform.ensureCommentRemoval(branchPr.number, topic);
            }
          } else {
            let content = emojify(
              `:construction_worker: This PR has received other commits, so Renovate will stop updating it to avoid conflicts or other problems.`
            );
            content += ` If you wish to abandon your changes and have Renovate start over you may click the "rebase" checkbox in the PR body/description.`;
            if (!config.suppressNotifications.includes('prEditNotification')) {
              if (config.dryRun) {
                logger.info(
                  'DRY-RUN: ensure comment in PR #' + branchPr.number
                );
              } else {
                await platform.ensureComment({
                  number: branchPr.number,
                  topic,
                  content,
                });
              }
            }
            res.branchResult = BranchResult.BlockedByCommits;
            return res;
          }
        }
      }
    }

    // Check schedule
    config.isScheduledNow = isScheduledNow(config);
    if (!config.isScheduledNow && !masterIssueCheck) {
      if (!branchExists) {
        logger.debug('Skipping branch creation as not within schedule');
        res.branchResult = BranchResult.AwaitingScheduledCreation;
        return res;
      }
      if (config.updateNotScheduled === false && !config.rebaseRequested) {
        logger.debug('Skipping branch update as not within schedule');
        res.branchResult = BranchResult.AwaitingScheduledUpdate;
        return res;
      }
      // istanbul ignore if
      if (!branchPr) {
        logger.debug('Skipping PR creation out of schedule');
        res.branchResult = BranchResult.AwaitingScheduledCreation;
        return res;
      }
      logger.debug(
        'Branch + PR exists but is not scheduled -- will update if necessary'
      );
    }

    if (
      config.updateType !== 'lockFileMaintenance' &&
      config.unpublishSafe &&
      config.canBeUnpublished &&
      (config.prCreation === 'not-pending' ||
        /* istanbul ignore next */ config.prCreation === 'status-success')
    ) {
      logger.debug(
        'Skipping branch creation due to unpublishSafe + status checks'
      );
      res.branchResult = BranchResult.AwaitingStability;
      return res;
    }

    if (
      config.upgrades.some(
        upgrade => upgrade.stabilityDays && upgrade.releaseTimestamp
      )
    ) {
      // Only set a stability status check if one or more of the updates contain
      // both a stabilityDays setting and a releaseTimestamp
      config.stabilityStatus = BranchStatus.green;
      // Default to 'success' but set 'pending' if any update is pending
      const oneDay = 24 * 60 * 60 * 1000;
      for (const upgrade of config.upgrades) {
        if (upgrade.stabilityDays && upgrade.releaseTimestamp) {
          const daysElapsed = Math.floor(
            (new Date().getTime() -
              new Date(upgrade.releaseTimestamp).getTime()) /
              oneDay
          );
          if (!masterIssueCheck && daysElapsed < upgrade.stabilityDays) {
            logger.debug(
              {
                depName: upgrade.depName,
                daysElapsed,
                stabilityDays: upgrade.stabilityDays,
              },
              'Update has not passed stability days'
            );
            config.stabilityStatus = BranchStatus.yellow;
          }
        }
      }
      // Don't create a branch if we know it will be status 'pending'
      if (
        !masterIssueCheck &&
        !branchExists &&
        config.stabilityStatus === BranchStatus.yellow &&
        ['not-pending', 'status-success'].includes(config.prCreation)
      ) {
        logger.debug('Skipping branch creation due to stability days not met');
        res.branchResult = BranchResult.AwaitingStability;
        return res;
      }
    }
    // We don't want to do any work if previous branches have been automerged, because the base branch will be out of date
    if (alreadyAutomerged) return res;
    // istanbul ignore if
    if (masterIssueCheck === 'rebase' || config.masterIssueRebaseAllOpen) {
      logger.debug('Manual rebase requested via master issue');
      delete config.parentBranch;
    } else {
      Object.assign(config, await getParentBranch(config));
    }
    logger.debug(`Using parentBranch: ${config.parentBranch}`);
    const updatedFiles = await getUpdatedPackageFiles(config);
    // istanbul ignore if
    if (updatedFiles.artifactErrors && config.artifactErrors) {
      updatedFiles.artifactErrors = config.artifactErrors.concat(
        updatedFiles.artifactErrors
      );
    }
    Object.assign(config, updatedFiles);
    if (config.updatedPackageFiles && config.updatedPackageFiles.length) {
      logger.debug(
        `Updated ${config.updatedPackageFiles.length} package files`
      );
    } else {
      logger.debug('No package files need updating');
    }
    const additionalFiles = await getAdditionalFiles(config, packageFiles);
    config.artifactErrors = (config.artifactErrors || []).concat(
      additionalFiles.artifactErrors
    );
    config.updatedArtifacts = (config.updatedArtifacts || []).concat(
      additionalFiles.updatedArtifacts
    );
    if (config.updatedArtifacts && config.updatedArtifacts.length) {
      logger.debug(
        {
          updatedArtifacts: config.updatedArtifacts.map(f =>
            f.name === '|delete|' ? `${f.contents} (delete)` : f.name
          ),
        },
        `Updated ${config.updatedArtifacts.length} lock files`
      );
    } else {
      logger.debug('No updated lock files in branch');
    }

    if (
      global.trustLevel === 'high' &&
      is.nonEmptyArray(config.allowedPostUpgradeCommands)
    ) {
      logger.debug(
        {
          tasks: config.postUpgradeTasks,
          allowedCommands: config.allowedPostUpgradeCommands,
        },
        'Checking for post-upgrade tasks'
      );
      const commands = config.postUpgradeTasks.commands || [];
      const fileFilters = config.postUpgradeTasks.fileFilters || [];

      if (is.nonEmptyArray(commands)) {
        for (const cmd of commands) {
          if (
            !config.allowedPostUpgradeCommands.some(pattern =>
              regEx(pattern).test(cmd)
            )
          ) {
            logger.warn(
              {
                cmd,
                allowedPostUpgradeCommands: config.allowedPostUpgradeCommands,
              },
              'Post-upgrade task did not match any on allowed list'
            );
          } else {
            logger.debug({ cmd }, 'Executing post-upgrade task');

            const execResult = await exec(cmd, {
              cwd: config.localDir,
            });

            logger.debug({ cmd, ...execResult }, 'Executed post-upgrade task');
          }
        }

        const status = await platform.getRepoStatus();

        for (const relativePath of status.modified.concat(status.not_added)) {
          for (const pattern of fileFilters) {
            if (minimatch(relativePath, pattern)) {
              logger.debug(
                { file: relativePath, pattern },
                'Post-upgrade file saved'
              );
              const existingContent = await readFile(
                join(config.localDir, relativePath)
              );
              config.updatedArtifacts.push({
                name: relativePath,
                contents: existingContent.toString(),
              });
            }
          }
        }

        for (const relativePath of status.deleted || []) {
          for (const pattern of fileFilters) {
            if (minimatch(relativePath, pattern)) {
              logger.debug(
                { file: relativePath, pattern },
                'Post-upgrade file removed'
              );
              config.updatedArtifacts.push({
                name: '|delete|',
                contents: relativePath,
              });
            }
          }
        }
      }
    }

    if (config.artifactErrors && config.artifactErrors.length) {
      if (config.releaseTimestamp) {
        logger.debug(`Branch timestamp: ` + config.releaseTimestamp);
        const releaseTimestamp = DateTime.fromISO(config.releaseTimestamp);
        if (releaseTimestamp.plus({ days: 1 }) < DateTime.local()) {
          logger.debug(
            'PR is older than a day, raise PR with lock file errors'
          );
        } else if (branchExists) {
          logger.debug(
            'PR is less than a day old but branchExists so updating anyway'
          );
        } else {
          logger.debug('PR is less than a day old - raise error instead of PR');
          throw new Error(MANAGER_LOCKFILE_ERROR);
        }
      } else {
        logger.debug('PR has no releaseTimestamp');
      }
    }
    const { commitHash, reason } = await commitFilesToBranch(config);
    if (commitHash) {
      // a commit was made
      if (branchExists) {
        logger.info({ commitHash }, `Branch updated`);
        res.branchResult = BranchResult.Rebased;
      } else {
        branchExists = true;
        logger.info({ commitHash }, `Branch created`);
        res.branchResult = BranchResult.Created;
      }
    } else {
      // No commit was made
      if (reason === 'dry-run') {
        return res;
      }
      if (!branchExists) {
        // No commit to make - branch aborted
        res.branchResult = BranchResult.ErrorNoCommit;
        return res;
      }
      // istanbul ignore if
      if (config.updateType === 'lockFileMaintenance' && !config.parentBranch) {
        // No lock file maintenance left to do
        logger.info(
          'Deleting lock file maintenance branch as master lock file no longer needs updating'
        );
        if (config.dryRun) {
          logger.info('DRY-RUN: Would delete lock file maintenance branch');
        } else {
          await platform.deleteBranch(config.branchName);
          res.branchExists = false;
          res.branchResult = BranchResult.Deleted;
        }
        return res;
      }
      // We attempted to push a pointless commit
      res.branchResult = BranchResult.PointlessRebase; // don't call it an error because it could have been a manually requested rebase
    }
    // Set branch statuses
    await setStability(config);
    await setUnpublishable(config);

    // break if we pushed a new commit because status check are pretty sure pending but maybe not reported yet
    if (
      commitHash &&
      (config.requiredStatusChecks?.length || config.prCreation !== 'immediate')
    ) {
      logger.debug({ commitHash }, `Branch status pending`);
      res.branchExists = true;
      res.prResult = PrResult.AwaitingNotPending;
      return res;
    }

    // Try to automerge branch and finish if successful, but only if branch already existed before this run
    if (branchExists || !config.requiredStatusChecks) {
      const mergeStatus = await tryBranchAutomerge(config);
      logger.debug(`mergeStatus=${mergeStatus}`);
      if (mergeStatus === 'automerged') {
        logger.debug('Branch is automerged - returning');
        res.branchExists = false;
        res.branchResult = BranchResult.Automerged;
        return res;
      }
      if (
        mergeStatus === 'automerge aborted - PR exists' ||
        mergeStatus === 'branch status error' ||
        mergeStatus === 'failed'
      ) {
        logger.debug({ mergeStatus }, 'Branch automerge not possible');
        config.forcePr = true;
        config.branchAutomergeFailureMessage = mergeStatus;
      }
    }
  } catch (err) /* istanbul ignore next */ {
    if (err.statusCode === 404) {
      throw new Error(REPOSITORY_CHANGED);
    }
    if (err.message === PLATFORM_RATE_LIMIT_EXCEEDED) {
      logger.debug('Passing rate-limit-exceeded error up');
      throw err;
    }
    if (err.message === REPOSITORY_CHANGED) {
      logger.debug('Passing repository-changed error up');
      throw err;
    }
    if (
      err.message &&
      err.message.startsWith('remote: Invalid username or password')
    ) {
      logger.debug('Throwing bad credentials');
      throw new Error(PLATFORM_BAD_CREDENTIALS);
    }
    if (
      err.message &&
      err.message.startsWith(
        'ssh_exchange_identification: Connection closed by remote host'
      )
    ) {
      logger.debug('Throwing bad credentials');
      throw new Error(PLATFORM_BAD_CREDENTIALS);
    }
    if (err.message === PLATFORM_BAD_CREDENTIALS) {
      logger.debug('Passing bad-credentials error up');
      throw err;
    }
    if (err.message === PLATFORM_INTEGRATION_UNAUTHORIZED) {
      logger.debug('Passing integration-unauthorized error up');
      throw err;
    }
    if (err.message === MANAGER_LOCKFILE_ERROR) {
      logger.debug('Passing lockfile-error up');
      throw err;
    }
    if (err.message && err.message.includes('space left on device')) {
      throw new Error(SYSTEM_INSUFFICIENT_DISK_SPACE);
    }
    if (err.message === SYSTEM_INSUFFICIENT_DISK_SPACE) {
      logger.debug('Passing disk-space error up');
      throw err;
    }
    if (err.message.startsWith('Resource not accessible by integration')) {
      logger.debug('Passing 403 error up');
      throw err;
    }
    if (err.message === WORKER_FILE_UPDATE_FAILED) {
      logger.warn('Error updating branch: update failure');
    } else if (err.message.startsWith('bundler-')) {
      // we have already warned inside the bundler artifacts error handling, so just return
      res.branchResult = BranchResult.ErrorBundler;
      return res;
    } else if (
      err.messagee &&
      err.message.includes('fatal: Authentication failed')
    ) {
      throw new Error(PLATFORM_AUTHENTICATION_ERROR);
    } else if (
      err.message !== DATASOURCE_FAILURE &&
      err.message !== PLATFORM_FAILURE
    ) {
      logger.error({ err }, `Error updating branch: ${err.message}`);
    }
    // Don't throw here - we don't want to stop the other renovations
    res.branchResult = BranchResult.ErrorUnknown;
    return res;
  }
  let pr;
  try {
    logger.debug('Ensuring PR');
    logger.debug(
      `There are ${config.errors.length} errors and ${config.warnings.length} warnings`
    );
    const ensurePrResult = await ensurePr(config);
    pr = ensurePrResult.pr;
    res.prExists = !!pr;
    res.prResult = ensurePrResult.prResult;
    if (!pr) {
      return res;
    }
    const topic = emojify(':warning: Artifact update problem');
    if (config.artifactErrors && config.artifactErrors.length) {
      logger.warn({ artifactErrors: config.artifactErrors }, 'artifactErrors');
      let content = `Renovate failed to update `;
      content += config.artifactErrors.length > 1 ? 'artifacts' : 'an artifact';
      content +=
        ' related to this branch. You probably do not want to merge this PR as-is.';
      content += emojify(
        `\n\n:recycle: Renovate will retry this branch, including artifacts, only when one of the following happens:\n\n`
      );
      content +=
        ' - any of the package files in this branch needs updating, or \n';
      content += ' - the branch becomes conflicted, or\n';
      content += ' - you check the rebase/retry checkbox if found above, or\n';
      content +=
        ' - you rename this PR\'s title to start with "rebase!" to trigger it manually';
      content += '\n\nThe artifact failure details are included below:\n\n';
      config.artifactErrors.forEach(error => {
        content += `##### File name: ${error.lockFile}\n\n`;
        content += `\`\`\`\n${error.stderr}\n\`\`\`\n\n`;
      });
      if (
        !(
          config.suppressNotifications.includes('artifactErrors') ||
          config.suppressNotifications.includes('lockFileErrors')
        )
      ) {
        if (config.dryRun) {
          logger.info(
            'DRY-RUN: Would ensure lock file error comment in PR #' + pr.number
          );
        } else {
          await platform.ensureComment({
            number: pr.number,
            topic,
            content,
          });
          // TODO: remoe this soon once they're all cleared out
          await platform.ensureCommentRemoval(
            pr.number,
            ':warning: Lock file problem'
          );
        }
      }
      const context = `renovate/artifacts`;
      const description = 'Artifact file update failure';
      const state = BranchStatus.red;
      const existingState = await platform.getBranchStatusCheck(
        config.branchName,
        context
      );
      // Check if state needs setting
      if (existingState !== state) {
        logger.debug(`Updating status check state to failed`);
        if (config.dryRun) {
          logger.info(
            'DRY-RUN: Would set branch status in ' + config.branchName
          );
        } else {
          await platform.setBranchStatus({
            branchName: config.branchName,
            context,
            description,
            state,
          });
        }
      }
    } else {
      if (config.updatedArtifacts && config.updatedArtifacts.length) {
        // istanbul ignore if
        if (config.dryRun) {
          logger.info(
            'DRY-RUN: Would ensure comment removal in PR #' + pr.number
          );
        } else {
          await platform.ensureCommentRemoval(pr.number, topic);
        }
      }
      const prAutomerged = await checkAutoMerge(pr, config);
      if (prAutomerged) {
        res.prResult = PrResult.Automerged;
        return res;
      }
    }
  } catch (err) /* istanbul ignore next */ {
    if (
      [
        PLATFORM_RATE_LIMIT_EXCEEDED,
        PLATFORM_FAILURE,
        REPOSITORY_CHANGED,
      ].includes(err.message)
    ) {
      logger.debug('Passing PR error up');
      throw err;
    }
    // Otherwise don't throw here - we don't want to stop the other renovations
    logger.error({ err }, `Error ensuring PR: ${err.message}`);
    res.prResult = PrResult.Error;
  }
  return res;
}
