import { logger } from '../../logger';
import { platform, Pr } from '../../platform';
import {
  BranchConfig,
  BranchResult,
  PrResult,
  ProcessBranchResult,
} from '../common';
import { RenovateConfig } from '../../config';
import { PR_STATE_NOT_OPEN } from '../../constants/pull-requests';

enum Category {
  Deleted = 'Deleted',
  Skipped = 'Skipped',
  BranchApproval = 'BranchApproval',
  BranchPending = 'BranchPending',
  Scheduled = 'Scheduled',
  RateLimited = 'RateLimited',
  BranchAutomerge = 'BranchAutomerge',
  PrApproval = 'PrApproval',
  PrPending = 'PrPending',
  Open = 'Open',
  Error = 'Error',
  Edited = 'Edited',
  Ignored = 'Ignored',
  Unknown = 'Unknown',
}

const categoryHeadings: Record<Category, string[]> = {
  Deleted: null,
  Skipped: ['Skipped', 'These branches were skipped and will be tried next run'],
  BranchApproval: ['Awaiting Branch Approval', 'These branches won\'t be created until approved below'],
  BranchPending: ['Pending Branch Creation', 'Branch creation is pending for those below'],
  Scheduled: ['Awaiting Schedule', 'The below branches will be created once in schedule'],
  RateLimited: ['Rate Limited', 'These branches have not been created yet due to rate limits in place'],
  BranchAutomerge: ['Awaiting Branch Automerge', 'These branches will automerge once up-to-date and passing tests'],
  PrApproval: ['Awaiting PR Approval', 'These branches exist but are awaiting PR creation approval below'],
  PrPending: ['Pending PR Creation', 'These PRs will be created once status criteria is met'],
  Open: ['Open PRs', 'These PRs have been created'],
  Error: ['Branches with Errors', 'These branches reported errors'],
  Edited: ['PRs with Edits', 'These PRs have received commits from someone else and will not be updated further. Tick the checkbox below to abandon the edits and rebase'],
  Ignored: ['Ignored PRs', 'These PRs were closed/ignored and will not be recreated unless the checkbox below is ticked'],
  Unknown: ['Unknown status', 'These branches have an unknown status, which indicates that something has gone wrong']
}

const branchResultMapping: Record<BranchResult, Category> = {
  Automerged: Category.Deleted,
  AwaitingApproval: Category.BranchApproval,
  AwaitingHourlyLimit: Category.RateLimited,
  AwaitingScheduledCreation: Category.Scheduled,
  AwaitingScheduledUpdate: null,
  AwaitingStability: Category.BranchPending,
  BlockedByClosedPr: Category.Ignored,
  BlockedByCommits: Category.Edited,
  Created: null,
  Deleted: Category.Deleted,
  ErrorBundler: Category.Error,
  ErrorNoCommit: Category.Error,
  ErrorUnknown: Category.Error,
  NotAttempted: Category.Skipped,
  NotUpdated: null,
  PointlessRebase: null,
  Rebased: null,
};

const prResultMapping: Record<PrResult, Category> = {
  Automerged: Category.Deleted,
  AwaitingApproval: Category.PrApproval,
  AwaitingGreenBranch: Category.PrPending,
  AwaitingNotPending: Category.PrPending,
  BlockedByBranchAutomerge: Category.BranchAutomerge,
  Created: Category.Open,
  Error: Category.Error,
  ErrorAlreadyExists: Category.Error,
  NotAttempted: Category.PrPending,
  NotUpdated: Category.Open,
  Updated: Category.Open,
};

function mapBranchResToMasterIssueCategory(res: ProcessBranchResult): Category {
  const category: Category =
    branchResultMapping[res.branchResult] || prResultMapping[res.branchResult];
  if (category) return category;
  logger.warn(
    { branchResult: res.branchResult, prResult: res.prResult },
    'Could not map result to master issue category'
  );
  return Category.Unknown;
}

function getListItem(branch: BranchConfig, type: string, pr?: Pr): string {
  let item = ' - [ ] ';
  item += `<!-- ${type}-branch=${branch.branchName} -->`;
  if (pr) {
    item += `[${branch.prTitle}](../pull/${pr.number})`;
  } else {
    item += branch.prTitle;
  }
  const uniquePackages = [
    ...new Set(branch.upgrades.map(upgrade => '`' + upgrade.depName + '`')),
  ];
  if (uniquePackages.length < 2) {
    return item + '\n';
  }
  return item + ' (' + uniquePackages.join(', ') + ')\n';
}

export async function ensureMasterIssue(
  config: RenovateConfig,
  branches: BranchConfig[]
): Promise<void> {
  if (
    !(
      config.masterIssue ||
      branches.some(
        branch => branch.masterIssueApproval || branch.masterIssuePrApproval
      )
    )
  ) {
    return;
  }
  logger.debug('Ensuring master issue');
  if (!branches.length) {
    if (config.masterIssueAutoclose) {
      logger.debug('Closing master issue');
      if (config.dryRun) {
        logger.info(
          'DRY-RUN: Would close Master Issue ' + config.masterIssueTitle
        );
      } else {
        await platform.ensureIssueClosing(config.masterIssueTitle);
      }
      return;
    }
    if (config.dryRun) {
      logger.info(
        'DRY-RUN: Would ensure Master Issue ' + config.masterIssueTitle
      );
    } else {
      await platform.ensureIssue({
        title: config.masterIssueTitle,
        body:
          'This repository is up-to-date and has no outstanding updates open or pending.',
      });
    }
    return;
  }
  const categorizedBranches = branches.map(branch => ({
    ...branch,
    category: mapBranchResToMasterIssueCategory(branch.res),
  }));
  let issueBody = `This [master issue](https://renovatebot.com/blog/master-issue) contains a list of Renovate updates and their statuses.\n\n`;
  const pendingApprovals = categorizedBranches.filter(
    branch => branch.category === Category.BranchApproval;
  );
  if (pendingApprovals.length) {
    issueBody += '## Pending Approval\n\n';
    issueBody += `These branches will be created by Renovate only once you click their checkbox below.\n\n`;
    for (const branch of pendingApprovals) {
      issueBody += getListItem(branch, 'approve');
    }
    issueBody += '\n';
  }
  const awaitingSchedule = branches.filter(
    branch => branch.res === 'not-scheduled'
  );
  if (awaitingSchedule.length) {
    issueBody += '## Awaiting Schedule\n\n';
    issueBody +=
      'These updates are awaiting their schedule. Click on a checkbox to ignore the schedule.\n';
    for (const branch of awaitingSchedule) {
      issueBody += getListItem(branch, 'unschedule');
    }
    issueBody += '\n';
  }
  const rateLimited = branches.filter(
    branch => branch.res && branch.res.endsWith('pr-hourly-limit-reached')
  );
  if (rateLimited.length) {
    issueBody += '## Rate Limited\n\n';
    issueBody +=
      'These updates are currently rate limited. Click on a checkbox below to force their creation now.\n\n';
    for (const branch of rateLimited) {
      issueBody += getListItem(branch, 'unlimit');
    }
    issueBody += '\n';
  }
  const errorList = branches.filter(
    branch => branch.res && branch.res.endsWith('error')
  );
  if (errorList.length) {
    issueBody += '## Errored\n\n';
    issueBody +=
      'These updates encountered an error and will be retried. Click a checkbox below to force a retry now.\n\n';
    for (const branch of errorList) {
      issueBody += getListItem(branch, 'retry');
    }
    issueBody += '\n';
  }
  const awaitingPr = branches.filter(
    branch => branch.res === 'needs-pr-approval'
  );
  if (awaitingPr.length) {
    issueBody += '## PR Creation Approval Required\n\n';
    issueBody +=
      "These branches exist but PRs won't be created until you approve by ticking the checkbox.\n\n";
    for (const branch of awaitingPr) {
      issueBody += getListItem(branch, 'approvePr');
    }
    issueBody += '\n';
  }
  const prEdited = branches.filter(branch => branch.res === 'pr-edited');
  if (prEdited.length) {
    issueBody += '## Edited/Blocked\n\n';
    issueBody += `These updates have been manually edited so Renovate will no longer make changes. To discard all commits and start over, check the box below.\n\n`;
    for (const branch of prEdited) {
      const pr = await platform.getBranchPr(branch.branchName);
      issueBody += getListItem(branch, 'rebase', pr);
    }
    issueBody += '\n';
  }
  const prPending = branches.filter(branch => branch.res === 'pending');
  if (prPending.length) {
    issueBody += '## Pending Status Checks\n\n';
    issueBody += `These updates await pending status checks. To force their creation now, check the box below.\n\n`;
    for (const branch of prPending) {
      issueBody += getListItem(branch, 'approvePr');
    }
    issueBody += '\n';
  }
  const otherRes = [
    'pending',
    'needs-approval',
    'needs-pr-approval',
    'not-scheduled',
    'pr-hourly-limit-reached',
    'already-existed',
    'error',
    'automerged',
    'pr-edited',
  ];
  const inProgress = branches.filter(branch => !otherRes.includes(branch.res));
  if (inProgress.length) {
    issueBody += '## Open\n\n';
    issueBody +=
      'These updates have all been created already. Click a checkbox below to force a retry/rebase of any.\n\n';
    for (const branch of inProgress) {
      const pr = await platform.getBranchPr(branch.branchName);
      issueBody += getListItem(branch, 'rebase', pr);
    }
    if (inProgress.length > 2) {
      issueBody += ' - [ ] ';
      issueBody += '<!-- rebase-all-open-prs -->';
      issueBody +=
        '**Check this option to rebase all the above open PRs at once**';
      issueBody += '\n';
    }
    issueBody += '\n';
  }
  const alreadyExisted = branches.filter(
    branch => branch.res && branch.res.endsWith('already-existed')
  );
  if (alreadyExisted.length) {
    issueBody += '## Closed/Ignored\n\n';
    issueBody +=
      'These updates were closed unmerged and will not be recreated unless you click a checkbox below.\n\n';
    for (const branch of alreadyExisted) {
      const pr = await platform.findPr({
        branchName: branch.branchName,
        prTitle: branch.prTitle,
        state: PR_STATE_NOT_OPEN,
      });
      issueBody += getListItem(branch, 'recreate', pr);
    }
    issueBody += '\n';
  }

  // istanbul ignore if
  if (global.appMode) {
    issueBody +=
      '---\n<details><summary>Advanced</summary>\n\n- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository\n\n</details>\n';
  }

  if (config.dryRun) {
    logger.info(
      'DRY-RUN: Would ensure Master Issue ' + config.masterIssueTitle
    );
  } else {
    await platform.ensureIssue({
      title: config.masterIssueTitle,
      body: issueBody,
    });
  }
}
